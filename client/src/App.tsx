import { useEffect, useRef, useState } from 'react';
import type { FileCompletePeerMessage, FileMetadataPeerMessage, PeerMessage, RoomStatePayload, SignalPayload } from '@peerpair/shared';
import { socketClient } from './lib/socket/socketClient';
import { socketEvents } from './lib/socket/socketEvents';
import { createDataChannel } from './lib/webrtc/dataChannel';
import { createPeerConnection } from './lib/webrtc/peerConnection';
import './styles/global.css';

type Toast = {
  id: number;
  message: string;
};

type IncomingFileState = {
  transferId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  receivedBytes: number;
  downloadUrl: string | null;
};

type IncomingTransferBuffer = {
  transferId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  chunks: Array<ArrayBuffer>;
  receivedBytes: number;
  startedAt: number;
};

type TransferMetrics = {
  direction: 'send' | 'receive';
  fileName: string;
  totalBytes: number;
  durationMs: number;
  speedMbps: number;
  peakBufferedAmount?: number;
};

const CHUNK_SIZE_BYTES = 256 * 1024;
const BUFFER_HIGH_WATERMARK_BYTES = 4 * 1024 * 1024;
const BUFFER_LOW_WATERMARK_BYTES = 1 * 1024 * 1024;
const UI_UPDATE_INTERVAL_MS = 150;
const MAX_CONNECTION_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 1200;
const DATA_CHANNEL_OPEN_TIMEOUT_MS = 12000;

export function App() {
  const [currentPage, setCurrentPage] = useState<'home' | 'share'>('home');
  const [isConnected, setIsConnected] = useState(socketClient.connected);
  const [roomId, setRoomId] = useState<string>('');
  const [joinedRoomId, setJoinedRoomId] = useState<string | null>(null);
  const [peers, setPeers] = useState<string[]>([]);
  const [statusMessage, setStatusMessage] = useState<string>('Idle');
  const [rtcState, setRtcState] = useState<string>('new');
  const [channelState, setChannelState] = useState<string>('closed');
  const [chatLog, setChatLog] = useState<string[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [transferStatus, setTransferStatus] = useState<string>('Idle');
  const [incomingFile, setIncomingFile] = useState<IncomingFileState | null>(null);
  const [transferMetrics, setTransferMetrics] = useState<TransferMetrics | null>(null);

  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const incomingTransfersRef = useRef<Map<string, IncomingTransferBuffer>>(new Map());
  const lastIncomingUiUpdateRef = useRef<number>(0);
  const lastOutgoingUiUpdateRef = useRef<number>(0);
  const retryAttemptRef = useRef<number>(0);
  const retryTimerRef = useRef<number | null>(null);
  const dataChannelOpenTimerRef = useRef<number | null>(null);
  const isIntentionalLeaveRef = useRef<boolean>(false);
  const retryInProgressRef = useRef<boolean>(false);
  const shouldCreateOfferRef = useRef<boolean>(false);

  function clearRetryTimer() {
    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }

  function clearDataChannelOpenTimer() {
    if (dataChannelOpenTimerRef.current !== null) {
      window.clearTimeout(dataChannelOpenTimerRef.current);
      dataChannelOpenTimerRef.current = null;
    }
  }

  function resetRetryState() {
    clearRetryTimer();
    clearDataChannelOpenTimer();
    retryAttemptRef.current = 0;
    retryInProgressRef.current = false;
  }

  function cleanupConnectionOnly() {
    clearDataChannelOpenTimer();
    if (dataChannelRef.current) {
      dataChannelRef.current.onopen = null;
      dataChannelRef.current.onclose = null;
      dataChannelRef.current.onmessage = null;
      dataChannelRef.current.close();
      dataChannelRef.current = null;
    }

    if (peerConnectionRef.current) {
      peerConnectionRef.current.onicecandidate = null;
      peerConnectionRef.current.onconnectionstatechange = null;
      peerConnectionRef.current.ondatachannel = null;
      peerConnectionRef.current.oniceconnectionstatechange = null;
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }

    setRtcState('closed');
    setChannelState('closed');
  }

  function safeParsePeerMessage(raw: string): PeerMessage | null {
    try {
      const parsed = JSON.parse(raw) as PeerMessage;
      if (!parsed || typeof parsed !== 'object' || !('type' in parsed)) {
        return null;
      }

      return parsed;
    } catch {
      return null;
    }
  }

  function sendControlMessage(message: PeerMessage) {
    const channel = dataChannelRef.current;
    if (!channel || channel.readyState !== 'open') {
      throw new Error('DataChannel is not open');
    }

    channel.send(JSON.stringify(message));
  }

  function toMbps(totalBytes: number, durationMs: number): number {
    if (durationMs <= 0) {
      return 0;
    }

    const bits = totalBytes * 8;
    return bits / (durationMs / 1000) / 1_000_000;
  }

  function formatBytes(totalBytes: number): string {
    if (totalBytes >= 1024 * 1024 * 1024) {
      return `${(totalBytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    }

    if (totalBytes >= 1024 * 1024) {
      return `${(totalBytes / (1024 * 1024)).toFixed(2)} MB`;
    }

    if (totalBytes >= 1024) {
      return `${Math.ceil(totalBytes / 1024)} KB`;
    }

    return `${totalBytes} bytes`;
  }

  function waitForBufferToDrain(channel: RTCDataChannel): Promise<void> {
    if (channel.readyState !== 'open') {
      return Promise.reject(new Error('Data channel is not open'));
    }

    if (channel.bufferedAmount <= BUFFER_HIGH_WATERMARK_BYTES) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const onLow = () => {
        cleanup();
        resolve();
      };

      const onClose = () => {
        cleanup();
        reject(new Error('Data channel closed while waiting for buffer to drain'));
      };

      const cleanup = () => {
        channel.removeEventListener('bufferedamountlow', onLow);
        channel.removeEventListener('close', onClose);
        channel.removeEventListener('error', onClose);
      };

      channel.addEventListener('bufferedamountlow', onLow);
      channel.addEventListener('close', onClose);
      channel.addEventListener('error', onClose);
    });
  }

  function clearIncomingTransfers() {
    incomingTransfersRef.current.clear();
    setIncomingFile((current) => {
      if (current?.downloadUrl) {
        URL.revokeObjectURL(current.downloadUrl);
      }

      return null;
    });
  }

  function addChatLog(message: string) {
    setChatLog((current) => [...current, message]);
  }

  function removeToast(id: number) {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }

  function pushErrorToast(message: string) {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    setToasts((current) => [...current, { id, message }]);

    window.setTimeout(() => {
      removeToast(id);
    }, 3600);
  }

  function scheduleReconnect(reason: string) {
    if (isIntentionalLeaveRef.current || !joinedRoomId) {
      return;
    }

    if (retryInProgressRef.current) {
      return;
    }

    if (retryAttemptRef.current >= MAX_CONNECTION_RETRIES) {
      setStatusMessage(`WebRTC reconnect failed after ${MAX_CONNECTION_RETRIES} retries`);
      pushErrorToast('Connection failed after retries. Please try leaving and rejoining.');
      return;
    }

    retryInProgressRef.current = true;
    retryAttemptRef.current += 1;
    const jitter = Math.floor(Math.random() * 300);
    const delay = RETRY_BASE_DELAY_MS * 2 ** (retryAttemptRef.current - 1) + jitter;
    setStatusMessage(`Reconnecting (${retryAttemptRef.current}/${MAX_CONNECTION_RETRIES})...`);
    addChatLog(`[system] Reconnect scheduled (${reason}) in ${Math.round(delay)}ms`);

    cleanupConnectionOnly();
    clearRetryTimer();
    retryTimerRef.current = window.setTimeout(() => {
      retryInProgressRef.current = false;
      if (!joinedRoomId || isIntentionalLeaveRef.current) {
        return;
      }

      if (shouldCreateOfferRef.current) {
        void createAndSendOffer(joinedRoomId);
      } else {
        ensurePeerConnection(joinedRoomId);
      }
    }, delay);
  }

  function cleanupPeerConnection() {
    resetRetryState();
    cleanupConnectionOnly();
    clearIncomingTransfers();
  }

  function attachDataChannel(channel: RTCDataChannel) {
    dataChannelRef.current = channel;
    channel.bufferedAmountLowThreshold = BUFFER_LOW_WATERMARK_BYTES;
    setChannelState(channel.readyState);

    channel.onopen = () => {
      clearDataChannelOpenTimer();
      resetRetryState();
      setChannelState(channel.readyState);
      setStatusMessage('Peer connection established');
      addChatLog('[system] DataChannel open');
    };

    channel.onclose = () => {
      setChannelState(channel.readyState);
      addChatLog('[system] DataChannel closed');
      scheduleReconnect('datachannel closed');
    };

    channel.onmessage = (event) => {
      if (typeof event.data === 'string') {
        const message = safeParsePeerMessage(event.data);
        if (!message) {
          addChatLog(`[peer] ${event.data}`);
          return;
        }

        if (message.type === 'text') {
          addChatLog(`[peer] ${message.payload.message}`);
          return;
        }

        if (message.type === 'file-metadata') {
          const payload = (message as FileMetadataPeerMessage).payload;
          setTransferMetrics(null);
          const incomingTransfer: IncomingTransferBuffer = {
            transferId: payload.transferId,
            fileName: payload.fileName,
            fileSize: payload.fileSize,
            mimeType: payload.mimeType,
            chunks: [],
            receivedBytes: 0,
            startedAt: performance.now(),
          };

          incomingTransfersRef.current.set(payload.transferId, incomingTransfer);

          setIncomingFile((current) => {
            if (current?.downloadUrl) {
              URL.revokeObjectURL(current.downloadUrl);
            }

            return {
              transferId: payload.transferId,
              fileName: payload.fileName,
              fileSize: payload.fileSize,
              mimeType: payload.mimeType,
              receivedBytes: 0,
              downloadUrl: null,
            };
          });
          setTransferStatus(`Receiving ${payload.fileName}`);
          return;
        }

        if (message.type === 'file-complete') {
          setTransferStatus('Transfer complete verified by receiver');
          return;
        }

        return;
      }

      const processBinaryChunk = (buffer: ArrayBuffer) => {
        const transfer = Array.from(incomingTransfersRef.current.values())[0];
        if (!transfer) {
          pushErrorToast('Binary chunk received for unknown transfer');
          return;
        }

        transfer.chunks.push(buffer);
        transfer.receivedBytes += buffer.byteLength;

        const now = performance.now();
        const shouldUpdateUi =
          now - lastIncomingUiUpdateRef.current >= UI_UPDATE_INTERVAL_MS || transfer.receivedBytes >= transfer.fileSize;
        if (shouldUpdateUi) {
          setIncomingFile((current) => {
            if (!current || current.transferId !== transfer.transferId) {
              return current;
            }

            return {
              ...current,
              receivedBytes: transfer.receivedBytes,
            };
          });
          lastIncomingUiUpdateRef.current = now;
        }

        if (transfer.receivedBytes >= transfer.fileSize) {
          const blob = new Blob(transfer.chunks, { type: transfer.mimeType || 'application/octet-stream' });

          if (blob.size !== transfer.fileSize) {
            pushErrorToast('Received file size does not match');
            setTransferStatus('Receive failed: size mismatch');
            return;
          }

          try {
            sendControlMessage({
              type: 'file-complete',
              payload: {
                transferId: transfer.transferId,
                totalBytes: blob.size,
              },
            });
          } catch {
            pushErrorToast('Failed to send file-complete');
          }

          const downloadUrl = URL.createObjectURL(blob);
          setIncomingFile((current) => {
            if (!current) return current;
            if (current.downloadUrl) URL.revokeObjectURL(current.downloadUrl);
            return {
              ...current,
              receivedBytes: blob.size,
              downloadUrl,
            };
          });

          setTransferStatus('File received');
          const durationMs = performance.now() - transfer.startedAt;
          setTransferMetrics({
            direction: 'receive',
            fileName: transfer.fileName,
            totalBytes: blob.size,
            durationMs,
            speedMbps: toMbps(blob.size, durationMs),
          });
          incomingTransfersRef.current.delete(transfer.transferId);
        }
      };

      if (event.data instanceof ArrayBuffer) {
        processBinaryChunk(event.data);
        return;
      }

      if (event.data instanceof Blob) {
        void event.data.arrayBuffer().then(processBinaryChunk);
      }
    };
  }

  function ensurePeerConnection(activeRoomId: string): RTCPeerConnection {
    if (peerConnectionRef.current) {
      return peerConnectionRef.current;
    }

    const peerConnection = createPeerConnection();

    peerConnection.onicecandidate = (event) => {
      if (!event.candidate) {
        return;
      }

      socketClient.emit(socketEvents.iceCandidate, {
        roomId: activeRoomId,
        fromPeerId: socketClient.id ?? '',
        data: event.candidate.toJSON(),
      });
    };

    peerConnection.onconnectionstatechange = () => {
      setRtcState(peerConnection.connectionState);
      if (peerConnection.connectionState === 'failed') {
        scheduleReconnect('peer connection failed');
      }
    };

    peerConnection.oniceconnectionstatechange = () => {
      if (peerConnection.iceConnectionState === 'failed') {
        scheduleReconnect('ice connection failed');
      }
    };

    peerConnection.ondatachannel = (event) => {
      attachDataChannel(event.channel);
    };

    peerConnectionRef.current = peerConnection;
    setRtcState(peerConnection.connectionState);
    return peerConnection;
  }

  async function createAndSendOffer(activeRoomId: string) {
    shouldCreateOfferRef.current = true;
    const peerConnection = ensurePeerConnection(activeRoomId);

    if (!dataChannelRef.current) {
      const channel = createDataChannel(peerConnection);
      attachDataChannel(channel);
    }

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    clearDataChannelOpenTimer();
    dataChannelOpenTimerRef.current = window.setTimeout(() => {
      if (dataChannelRef.current?.readyState !== 'open') {
        scheduleReconnect('datachannel open timeout');
      }
    }, DATA_CHANNEL_OPEN_TIMEOUT_MS);

    socketClient.emit(socketEvents.offer, {
      roomId: activeRoomId,
      fromPeerId: socketClient.id ?? '',
      data: offer,
    });
  }

  useEffect(() => {
    function onRoomState(payload: RoomStatePayload) {
      isIntentionalLeaveRef.current = false;
      setJoinedRoomId(payload.roomId);
      setRoomId(payload.roomId);
      setPeers(payload.peers);
      setStatusMessage(`In room ${payload.roomId}`);
      ensurePeerConnection(payload.roomId);
    }

    function onUserJoined(peerId: string) {
      setPeers((currentPeers) => {
        if (currentPeers.includes(peerId)) {
          return currentPeers;
        }

        return [...currentPeers, peerId];
      });
    }

    function onUserLeft(peerId: string) {
      setPeers((currentPeers) => currentPeers.filter((peer) => peer !== peerId));
    }

    socketClient.on(socketEvents.roomCreated, onRoomState);
    socketClient.on(socketEvents.roomJoined, onRoomState);
    socketClient.on(socketEvents.userJoined, onUserJoined);
    socketClient.on(socketEvents.userLeft, onUserLeft);

    return () => {
      socketClient.off(socketEvents.roomCreated, onRoomState);
      socketClient.off(socketEvents.roomJoined, onRoomState);
      socketClient.off(socketEvents.userJoined, onUserJoined);
      socketClient.off(socketEvents.userLeft, onUserLeft);
    };
  }, []);

  useEffect(() => {
    async function onOffer(payload: SignalPayload) {
      if (!joinedRoomId || payload.roomId !== joinedRoomId) {
        return;
      }

      try {
        shouldCreateOfferRef.current = false;
        const peerConnection = ensurePeerConnection(payload.roomId);
        await peerConnection.setRemoteDescription(payload.data as RTCSessionDescriptionInit);

        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);

        clearDataChannelOpenTimer();
        dataChannelOpenTimerRef.current = window.setTimeout(() => {
          if (dataChannelRef.current?.readyState !== 'open') {
            scheduleReconnect('receiver datachannel open timeout');
          }
        }, DATA_CHANNEL_OPEN_TIMEOUT_MS);

        socketClient.emit(socketEvents.answer, {
          roomId: payload.roomId,
          fromPeerId: socketClient.id ?? '',
          data: answer,
        });

        setStatusMessage(`Received offer from ${payload.fromPeerId}`);
      } catch {
        pushErrorToast('Failed to process incoming offer');
      }
    }

    async function onAnswer(payload: SignalPayload) {
      if (!joinedRoomId || payload.roomId !== joinedRoomId || !peerConnectionRef.current) {
        return;
      }

      try {
        await peerConnectionRef.current.setRemoteDescription(payload.data as RTCSessionDescriptionInit);
        setStatusMessage(`Received answer from ${payload.fromPeerId}`);
      } catch {
        pushErrorToast('Failed to apply answer');
      }
    }

    async function onIceCandidate(payload: SignalPayload) {
      if (!joinedRoomId || payload.roomId !== joinedRoomId || !peerConnectionRef.current) {
        return;
      }

      try {
        await peerConnectionRef.current.addIceCandidate(payload.data as RTCIceCandidateInit);
      } catch {
        pushErrorToast('Failed to apply ICE candidate');
      }
    }

    socketClient.on(socketEvents.offer, onOffer);
    socketClient.on(socketEvents.answer, onAnswer);
    socketClient.on(socketEvents.iceCandidate, onIceCandidate);

    return () => {
      socketClient.off(socketEvents.offer, onOffer);
      socketClient.off(socketEvents.answer, onAnswer);
      socketClient.off(socketEvents.iceCandidate, onIceCandidate);
    };
  }, [joinedRoomId]);

  useEffect(() => {
    return () => {
      isIntentionalLeaveRef.current = true;
      cleanupPeerConnection();
    };
  }, []);

  function handleCreateRoom() {
    socketClient.emit(socketEvents.createRoom, (ack) => {
      if (!ack?.ok) {
        setStatusMessage(ack?.message ?? 'Failed to create room');
        pushErrorToast(ack?.message ?? 'Failed to create room');
      }
    });
  }

  function handleJoinRoom() {
    const targetRoomId = roomId.trim().toUpperCase();
    if (!targetRoomId) {
      setStatusMessage('Enter a room ID first');
      pushErrorToast('Enter a room ID first');
      return;
    }

    socketClient.emit(socketEvents.joinRoom, targetRoomId, (ack) => {
      if (!ack?.ok) {
        setStatusMessage(ack?.message ?? 'Failed to join room');
        pushErrorToast(ack?.message ?? 'Failed to join room');
        return;
      }

      isIntentionalLeaveRef.current = false;
      setStatusMessage(`Joined room ${targetRoomId}`);
      void createAndSendOffer(targetRoomId);
    });
  }

  function handleLeaveRoom() {
    if (!joinedRoomId) {
      setStatusMessage('No active room to leave');
      pushErrorToast('No active room to leave');
      return;
    }

    isIntentionalLeaveRef.current = true;
    shouldCreateOfferRef.current = false;
    socketClient.emit(socketEvents.leaveRoom, joinedRoomId, (ack) => {
      if (!ack?.ok) {
        setStatusMessage(ack?.message ?? 'Failed to leave room');
        pushErrorToast(ack?.message ?? 'Failed to leave room');
        return;
      }

      setPeers([]);
      setJoinedRoomId(null);
      setStatusMessage('Left room successfully');
      cleanupPeerConnection();
    });
  }

  async function handleSendFile() {
    if (!selectedFile) {
      pushErrorToast('Pick a file before sending');
      return;
    }

    const channel = dataChannelRef.current;
    if (!channel || channel.readyState !== 'open') {
      pushErrorToast('DataChannel is not open yet');
      setTransferStatus('Send failed: channel closed');
      return;
    }

    try {
      const transferId = crypto.randomUUID();
      const startedAt = performance.now();
      let peakBufferedAmount = 0;
      lastOutgoingUiUpdateRef.current = startedAt;
      setTransferMetrics(null);
      setTransferStatus(`Starting transfer for ${selectedFile.name}`);

      sendControlMessage({
        type: 'file-metadata',
        payload: {
          transferId,
          fileName: selectedFile.name,
          fileSize: selectedFile.size,
          mimeType: selectedFile.type || 'application/octet-stream',
        },
      });

      const stream = selectedFile.stream();
      const reader = stream.getReader();
      let sentBytes = 0;

      while (true) {
        if (channel.bufferedAmount > BUFFER_HIGH_WATERMARK_BYTES) {
          await waitForBufferToDrain(channel);
        }

        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        let offset = 0;
        while (offset < value.byteLength) {
          if (channel.bufferedAmount > BUFFER_HIGH_WATERMARK_BYTES) {
            await waitForBufferToDrain(channel);
          }
          const chunkByteLength = Math.min(CHUNK_SIZE_BYTES, value.byteLength - offset);
          const chunk = value.subarray(offset, offset + chunkByteLength);
          channel.send(chunk);
          peakBufferedAmount = Math.max(peakBufferedAmount, channel.bufferedAmount);
          sentBytes += chunkByteLength;
          offset += chunkByteLength;

          const now = performance.now();
          if (now - lastOutgoingUiUpdateRef.current >= UI_UPDATE_INTERVAL_MS || sentBytes === selectedFile.size) {
            setTransferStatus(`Sending ${selectedFile.name}: ${sentBytes}/${selectedFile.size} bytes`);
            lastOutgoingUiUpdateRef.current = now;
          }
        }
      }

      setTransferStatus(`Sent all bytes for ${selectedFile.name}, waiting for receiver verification...`);
      const durationMs = performance.now() - startedAt;
      setTransferMetrics({
        direction: 'send',
        fileName: selectedFile.name,
        totalBytes: selectedFile.size,
        durationMs,
        speedMbps: toMbps(selectedFile.size, durationMs),
        peakBufferedAmount,
      });
    } catch {
      pushErrorToast('Failed to send file');
      setTransferStatus('Send failed');
    }
  }

  useEffect(() => {

    function onConnect() {
      setIsConnected(true);
    }

    function onDisconnect() {
      setIsConnected(false);
    }

    socketClient.on('connect', onConnect);
    socketClient.on('disconnect', onDisconnect);

    return () => {
      socketClient.off('connect', onConnect);
      socketClient.off('disconnect', onDisconnect);
    };
  }, []);

  const homePage = (
    <>
      <section className="hero-card home-hero">
        <div className="hero-content">
          <p className="eyebrow"><span className="brand-mark">PP</span> PeerPair</p>
          <h1>Private file sharing, <span>directly</span> between browsers</h1>
          <p className="hero-copy">
            PeerPair lets two people connect in a shared room and transfer files directly, with a simple workflow built for fast, secure handoffs.
          </p>
          <div className="room-actions hero-actions">
            <button className="btn primary hero-cta" onClick={() => setCurrentPage('share')}>
              <span aria-hidden="true">↥</span> Share Files
            </button>
          </div>
        </div>

        <div className="hero-visual" aria-hidden="true">
          <div className="orbit orbit-left"></div>
          <div className="orbit orbit-right"></div>
          <div className="spark spark-one">✦</div>
          <div className="spark spark-two">◆</div>
          <div className="spark spark-three">✦</div>
          <div className="file-card">
            <span></span>
            <span></span>
            <span></span>
          </div>
          <div className="transfer-arc"></div>
          <div className="check-bubble">✓</div>
          <div className="laptop laptop-left">
            <div className="laptop-screen">
              <div className="avatar avatar-yellow">●</div>
              <strong>You</strong>
            </div>
            <div className="laptop-base"></div>
          </div>
          <div className="laptop laptop-right">
            <div className="laptop-screen">
              <div className="avatar avatar-teal">●</div>
              <strong>Peer</strong>
            </div>
            <div className="laptop-base"></div>
          </div>
        </div>
      </section>

      <section className="feature-grid">
        <article className="panel feature-card feature-yellow">
          <div className="feature-icon">ϟ</div>
          <div>
            <h2>Direct Transfer</h2>
            <span className="feature-rule"></span>
            <p className="hero-copy feature-copy">
              Files move from one browser to another without uploading them into a separate storage workflow.
            </p>
          </div>
        </article>
        <article className="panel feature-card feature-teal">
          <div className="feature-icon">☊</div>
          <div>
            <h2>Simple Session Flow</h2>
            <span className="feature-rule"></span>
            <p className="hero-copy feature-copy">
              Create a room, share the room code, and start sending files as soon as the second participant joins.
            </p>
          </div>
        </article>
        <article className="panel feature-card feature-purple">
          <div className="feature-icon">▥</div>
          <div>
            <h2>Live Progress</h2>
            <span className="feature-rule"></span>
            <p className="hero-copy feature-copy">
              Track session status, transfer progress, and completed downloads in a single workspace.
            </p>
          </div>
        </article>
      </section>
    </>
  );

  const sharePage = (
    <>
      <section className="hero-card">
        <p className="eyebrow">PeerPair</p>
        <h1>Secure File Sharing Workspace</h1>
        <p className="hero-copy">
          Start a room, invite the other participant with the room code, and send files once the connection is ready.
        </p>
        <div className="room-actions hero-actions">
          <button className="btn" onClick={() => setCurrentPage('home')}>Home</button>
        </div>
      </section>

      <section className="panel room-panel">
        <h2>Room Access</h2>
        <div className="room-actions">
          <button className="btn primary" onClick={handleCreateRoom}>Create Room</button>
          <button className="btn" onClick={handleJoinRoom}>Join Room</button>
          <button className="btn danger" onClick={handleLeaveRoom}>Leave Room</button>
        </div>
        <input
          className="field"
          type="text"
          placeholder="Enter room ID"
          value={roomId}
          onChange={(event) => setRoomId(event.target.value)}
        />
        <div className="badge-row">
          <span className="badge">Active Room: {joinedRoomId ?? 'None'}</span>
          <span className="badge">Participants: {peers.length}</span>
        </div>
      </section>

      <section className="panel grid-panel">
        <div className="status-tile">
          <p className="label">Service Link</p>
          <p className={`value ${isConnected ? 'ok' : 'bad'}`}>{isConnected ? 'Connected' : 'Disconnected'}</p>
        </div>
        <div className="status-tile">
          <p className="label">Connection State</p>
          <p className="value">{rtcState}</p>
        </div>
        <div className="status-tile">
          <p className="label">Transfer Channel</p>
          <p className="value">{channelState}</p>
        </div>
        <div className="status-tile">
          <p className="label">Session Status</p>
          <p className="value">{statusMessage}</p>
        </div>
      </section>

      <section className="panel transfer-panel">
        <h2>Send Files</h2>
        <div className="transfer-row">
          <input
            className="field"
            type="file"
            onChange={(event) => {
              setSelectedFile(event.target.files?.[0] ?? null);
            }}
          />
          <button className="btn primary" onClick={() => void handleSendFile()}>Send File</button>
        </div>
        <p className="transfer-note">Transfer status: {transferStatus}</p>
        {transferMetrics ? (
          <p className="transfer-note">
            Last {transferMetrics.direction}: {transferMetrics.fileName} at {transferMetrics.speedMbps.toFixed(2)} Mbps in{' '}
            {(transferMetrics.durationMs / 1000).toFixed(2)}s
            {typeof transferMetrics.peakBufferedAmount === 'number'
              ? ` (peak buffer ${Math.round(transferMetrics.peakBufferedAmount / 1024)} KB)`
              : ''}
          </p>
        ) : null}
        {selectedFile ? (
          <p className="transfer-note">
            Selected: {selectedFile.name} ({formatBytes(selectedFile.size)})
          </p>
        ) : null}
        {incomingFile ? (
          <div className="incoming-card">
            <p>Incoming file: {incomingFile.fileName}</p>
            <p>
              Received: {formatBytes(incomingFile.receivedBytes)} / {formatBytes(incomingFile.fileSize)}
            </p>
            {incomingFile.downloadUrl ? (
              <a className="btn" href={incomingFile.downloadUrl} download={incomingFile.fileName}>
                Download File
              </a>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className="panel chat-panel">
        <h2>Session Activity</h2>
        <div className="log-box">
          {chatLog.length === 0 ? <p className="log-empty">No session activity yet</p> : null}
          {chatLog.map((entry, index) => (
            <p className="log-line" key={`${entry}-${index}`}>{entry}</p>
          ))}
        </div>
      </section>
    </>
  );

  return (
    <main className="app-shell">
      <aside className="toast-stack" aria-live="polite">
        {toasts.map((toast) => (
          <div className="toast toast-error" key={toast.id}>
            <span>{toast.message}</span>
            <button className="toast-close" onClick={() => removeToast(toast.id)}>x</button>
          </div>
        ))}
      </aside>

      {currentPage === 'home' ? homePage : sharePage}
    </main>
  );
}
