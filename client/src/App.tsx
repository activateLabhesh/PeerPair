import { useEffect, useRef, useState } from 'react';
import type { FileCompletePeerMessage, FileStartPeerMessage, PeerMessage, RoomStatePayload, SignalPayload } from '@peerpair/shared';
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
  receivedChunks: number;
  totalChunks: number;
  downloadUrl: string | null;
};

type IncomingTransferBuffer = {
  transferId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  totalChunks: number;
  chunks: Array<ArrayBuffer | null>;
  receivedBytes: number;
  receivedChunks: number;
  highestContiguousChunk: number;
};

const CHUNK_SIZE_BYTES = 64 * 1024;
const BUFFER_HIGH_WATERMARK_BYTES = 1 * 1024 * 1024;
const BUFFER_LOW_WATERMARK_BYTES = 256 * 1024;
const ACK_EVERY_CHUNKS = 8;

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

  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const incomingTransfersRef = useRef<Map<string, IncomingTransferBuffer>>(new Map());
  const pendingIncomingChunkRef = useRef<{
    transferId: string;
    chunkIndex: number;
    chunkByteLength: number;
  } | null>(null);

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

  function waitForBufferToDrain(channel: RTCDataChannel): Promise<void> {
    if (channel.bufferedAmount <= BUFFER_HIGH_WATERMARK_BYTES) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const onLow = () => {
        channel.removeEventListener('bufferedamountlow', onLow);
        resolve();
      };

      channel.addEventListener('bufferedamountlow', onLow);

      window.setTimeout(() => {
        channel.removeEventListener('bufferedamountlow', onLow);
        resolve();
      }, 1500);
    });
  }

  function clearIncomingTransfers() {
    incomingTransfersRef.current.clear();
    pendingIncomingChunkRef.current = null;
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

  function cleanupPeerConnection() {
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
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }

    setRtcState('closed');
    setChannelState('closed');
    clearIncomingTransfers();
  }

  function attachDataChannel(channel: RTCDataChannel) {
    dataChannelRef.current = channel;
    channel.bufferedAmountLowThreshold = BUFFER_LOW_WATERMARK_BYTES;
    setChannelState(channel.readyState);

    channel.onopen = () => {
      setChannelState(channel.readyState);
      addChatLog('[system] DataChannel open');
    };

    channel.onclose = () => {
      setChannelState(channel.readyState);
      addChatLog('[system] DataChannel closed');
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

        if (message.type === 'file-start') {
          const payload = (message as FileStartPeerMessage).payload;
          const incomingTransfer: IncomingTransferBuffer = {
            transferId: payload.transferId,
            fileName: payload.fileName,
            fileSize: payload.fileSize,
            mimeType: payload.mimeType,
            totalChunks: payload.totalChunks,
            chunks: new Array<ArrayBuffer | null>(payload.totalChunks).fill(null),
            receivedBytes: 0,
            receivedChunks: 0,
            highestContiguousChunk: -1,
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
              receivedChunks: 0,
              totalChunks: payload.totalChunks,
              downloadUrl: null,
            };
          });
          setTransferStatus(`Receiving ${payload.fileName}`);
          return;
        }

        if (message.type === 'file-chunk') {
          pendingIncomingChunkRef.current = {
            transferId: message.payload.transferId,
            chunkIndex: message.payload.chunkIndex,
            chunkByteLength: message.payload.chunkByteLength,
          };
          return;
        }

        if (message.type === 'file-ack') {
          const ackedChunks = message.payload.receivedUpToChunkIndex + 1;
          setTransferStatus(`Peer ACK: ${ackedChunks} chunks (${message.payload.receivedBytes} bytes)`);
          return;
        }

        if (message.type === 'file-error') {
          setTransferStatus(`Transfer failed: ${message.payload.message}`);
          pushErrorToast(`Peer transfer error: ${message.payload.message}`);
          return;
        }

        if (message.type === 'file-cancel') {
          setTransferStatus(`Transfer canceled: ${message.payload.reason ?? 'peer canceled'}`);
          pushErrorToast(`Peer canceled transfer${message.payload.reason ? `: ${message.payload.reason}` : ''}`);
          clearIncomingTransfers();
          return;
        }

        if (message.type === 'file-complete') {
          const payload = (message as FileCompletePeerMessage).payload;
          const transfer = incomingTransfersRef.current.get(payload.transferId);
          if (!transfer) {
            pushErrorToast('Transfer complete received without matching file-start');
            return;
          }

          if (transfer.receivedBytes !== payload.totalBytes || transfer.receivedChunks !== payload.totalChunks) {
            pushErrorToast('Received file size/chunk count does not match completion message');
            setTransferStatus('Receive failed: transfer mismatch');
            return;
          }

          const finalizedChunks = transfer.chunks.filter((chunk): chunk is ArrayBuffer => chunk !== null);
          const blob = new Blob(finalizedChunks, { type: transfer.mimeType || 'application/octet-stream' });

          if (blob.size !== payload.totalBytes) {
            pushErrorToast('Received file size does not match completion payload');
            setTransferStatus('Receive failed: size mismatch');
            return;
          }

          const downloadUrl = URL.createObjectURL(blob);
          setIncomingFile((current) => {
            if (!current) {
              return current;
            }

            if (current.downloadUrl) {
              URL.revokeObjectURL(current.downloadUrl);
            }

            return {
              ...current,
              receivedBytes: blob.size,
              receivedChunks: transfer.totalChunks,
              downloadUrl,
            };
          });
          setTransferStatus('File received');
          incomingTransfersRef.current.delete(payload.transferId);
          pendingIncomingChunkRef.current = null;
        }

        return;
      }

      const processBinaryChunk = (buffer: ArrayBuffer) => {
        const pendingHeader = pendingIncomingChunkRef.current;
        if (!pendingHeader) {
          pushErrorToast('Binary chunk received without file-chunk header');
          return;
        }

        const transfer = incomingTransfersRef.current.get(pendingHeader.transferId);
        if (!transfer) {
          pushErrorToast('Binary chunk received for unknown transfer');
          pendingIncomingChunkRef.current = null;
          return;
        }

        if (pendingHeader.chunkIndex < 0 || pendingHeader.chunkIndex >= transfer.totalChunks) {
          pushErrorToast('Invalid chunk index received');
          pendingIncomingChunkRef.current = null;
          return;
        }

        if (transfer.chunks[pendingHeader.chunkIndex] === null) {
          transfer.chunks[pendingHeader.chunkIndex] = buffer;
          transfer.receivedBytes += buffer.byteLength;
          transfer.receivedChunks += 1;

          while (
            transfer.highestContiguousChunk + 1 < transfer.totalChunks &&
            transfer.chunks[transfer.highestContiguousChunk + 1] !== null
          ) {
            transfer.highestContiguousChunk += 1;
          }
        }

        setIncomingFile((current) => {
          if (!current || current.transferId !== transfer.transferId) {
            return current;
          }

          return {
            ...current,
            receivedBytes: transfer.receivedBytes,
            receivedChunks: transfer.receivedChunks,
          };
        });

        if (
          transfer.receivedChunks % ACK_EVERY_CHUNKS === 0 ||
          transfer.receivedChunks === transfer.totalChunks
        ) {
          sendControlMessage({
            type: 'file-ack',
            payload: {
              transferId: transfer.transferId,
              receivedUpToChunkIndex: transfer.highestContiguousChunk,
              receivedBytes: transfer.receivedBytes,
            },
          });
        }

        pendingIncomingChunkRef.current = null;
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
    };

    peerConnection.ondatachannel = (event) => {
      attachDataChannel(event.channel);
    };

    peerConnectionRef.current = peerConnection;
    setRtcState(peerConnection.connectionState);
    return peerConnection;
  }

  async function createAndSendOffer(activeRoomId: string) {
    const peerConnection = ensurePeerConnection(activeRoomId);

    if (!dataChannelRef.current) {
      const channel = createDataChannel(peerConnection);
      attachDataChannel(channel);
    }

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    socketClient.emit(socketEvents.offer, {
      roomId: activeRoomId,
      fromPeerId: socketClient.id ?? '',
      data: offer,
    });
  }

  useEffect(() => {
    function onRoomState(payload: RoomStatePayload) {
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
        const peerConnection = ensurePeerConnection(payload.roomId);
        await peerConnection.setRemoteDescription(payload.data as RTCSessionDescriptionInit);

        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);

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
      const totalChunks = Math.ceil(selectedFile.size / CHUNK_SIZE_BYTES);
      setTransferStatus(`Starting transfer for ${selectedFile.name}`);

      sendControlMessage({
        type: 'file-start',
        payload: {
          transferId,
          fileName: selectedFile.name,
          fileSize: selectedFile.size,
          mimeType: selectedFile.type || 'application/octet-stream',
          chunkSize: CHUNK_SIZE_BYTES,
          totalChunks,
        },
      });

      for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
        await waitForBufferToDrain(channel);

        const start = chunkIndex * CHUNK_SIZE_BYTES;
        const end = Math.min(start + CHUNK_SIZE_BYTES, selectedFile.size);
        const chunkBuffer = await selectedFile.slice(start, end).arrayBuffer();

        sendControlMessage({
          type: 'file-chunk',
          payload: {
            transferId,
            chunkIndex,
            totalChunks,
            byteOffset: start,
            chunkByteLength: chunkBuffer.byteLength,
          },
        });

        channel.send(chunkBuffer);

        setTransferStatus(
          `Sending ${selectedFile.name}: ${chunkIndex + 1}/${totalChunks} chunks (${end}/${selectedFile.size} bytes)`
        );
      }

      sendControlMessage({
        type: 'file-complete',
        payload: {
          transferId,
          totalBytes: selectedFile.size,
          totalChunks,
        },
      });

      setTransferStatus(`Sent ${selectedFile.name}`);
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
            <p>
              Chunks: {incomingFile.receivedChunks} / {incomingFile.totalChunks}
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
