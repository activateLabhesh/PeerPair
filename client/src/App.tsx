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
  const [socketId, setSocketId] = useState<string | null>(socketClient.id ?? null);
  const [isConnected, setIsConnected] = useState(socketClient.connected);
  const [pongMessage, setPongMessage] = useState<string>('waiting');
  const [roomId, setRoomId] = useState<string>('');
  const [joinedRoomId, setJoinedRoomId] = useState<string | null>(null);
  const [peers, setPeers] = useState<string[]>([]);
  const [statusMessage, setStatusMessage] = useState<string>('Idle');
  const [rtcState, setRtcState] = useState<string>('new');
  const [channelState, setChannelState] = useState<string>('closed');
  const [chatMessage, setChatMessage] = useState<string>('');
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

  function handleSendMessage() {
    const message = chatMessage.trim();
    if (!message) {
      return;
    }

    const channel = dataChannelRef.current;
    if (!channel || channel.readyState !== 'open') {
      setStatusMessage('DataChannel is not open yet');
      pushErrorToast('DataChannel is not open yet');
      return;
    }

    const textMessage: PeerMessage = {
      type: 'text',
      payload: { message },
    };

    channel.send(JSON.stringify(textMessage));
    addChatLog(`[me] ${message}`);
    setChatMessage('');
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
      setSocketId(socketClient.id ?? null);
      socketClient.emit(socketEvents.ping, 'hello-phase-0', (response: { message: string }) => {
        setPongMessage(response.message);
      });
    }

    function onDisconnect() {
      setIsConnected(false);
      setSocketId(null);
    }

    function onPong(message: string) {
      setPongMessage(message);
    }

    socketClient.on('connect', onConnect);
    socketClient.on('disconnect', onDisconnect);
    socketClient.on(socketEvents.pong, onPong);

    return () => {
      socketClient.off('connect', onConnect);
      socketClient.off('disconnect', onDisconnect);
      socketClient.off(socketEvents.pong, onPong);
    };
  }, []);

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

      <section className="hero-card">
        <p className="eyebrow">PeerPair / Phase 2</p>
        <h1>Realtime Peer Signaling Playground</h1>
        <p className="hero-copy">
          Create a room, join with a second browser, and watch signaling + DataChannel state update live.
        </p>
      </section>

      <section className="panel room-panel">
        <h2>Room Control</h2>
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
          <span className="badge">Active: {joinedRoomId ?? 'None'}</span>
          <span className="badge">Peers: {peers.length}</span>
        </div>
      </section>

      <section className="panel grid-panel">
        <div className="status-tile">
          <p className="label">Socket</p>
          <p className={`value ${isConnected ? 'ok' : 'bad'}`}>{isConnected ? 'Connected' : 'Disconnected'}</p>
        </div>
        <div className="status-tile">
          <p className="label">WebRTC</p>
          <p className="value">{rtcState}</p>
        </div>
        <div className="status-tile">
          <p className="label">DataChannel</p>
          <p className="value">{channelState}</p>
        </div>
        <div className="status-tile">
          <p className="label">Room Status</p>
          <p className="value">{statusMessage}</p>
        </div>
      </section>

      <section className="panel chat-panel">
        <h2>DataChannel Chat</h2>
        <div className="chat-row">
          <input
            className="field"
            type="text"
            placeholder="Send message over DataChannel"
            value={chatMessage}
            onChange={(event) => setChatMessage(event.target.value)}
          />
          <button className="btn primary" onClick={handleSendMessage}>Send</button>
        </div>
        <div className="log-box">
          {chatLog.length === 0 ? <p className="log-empty">No messages yet</p> : null}
          {chatLog.map((entry, index) => (
            <p className="log-line" key={`${entry}-${index}`}>{entry}</p>
          ))}
        </div>
      </section>

      <section className="panel transfer-panel">
        <h2>Chunked File Transfer (Phase 5)</h2>
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
        <p className="transfer-note">Chunk size: {Math.round(CHUNK_SIZE_BYTES / 1024)} KB</p>
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
            Selected: {selectedFile.name} ({Math.ceil(selectedFile.size / 1024)} KB)
          </p>
        ) : null}
        {incomingFile ? (
          <div className="incoming-card">
            <p>Incoming: {incomingFile.fileName}</p>
            <p>
              Received: {incomingFile.receivedBytes} / {incomingFile.fileSize} bytes
            </p>
            {incomingFile.downloadUrl ? (
              <a className="btn" href={incomingFile.downloadUrl} download={incomingFile.fileName}>
                Download Received File
              </a>
            ) : null}
          </div>
        ) : null}
      </section>

      <footer className="meta">
        <span>Socket ID: {socketId ?? 'N/A'}</span>
        <span>Handshake: {pongMessage}</span>
      </footer>
    </main>
  );
}
