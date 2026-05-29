import { useEffect, useRef, useState } from 'react';
import type { FileCompletePeerMessage, FileMetaPeerMessage, PeerMessage, RoomStatePayload, SignalPayload } from '@peerpair/shared';
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

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

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
  const incomingChunksRef = useRef<ArrayBuffer[]>([]);
  const incomingTransferIdRef = useRef<string | null>(null);

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
    incomingChunksRef.current = [];
    incomingTransferIdRef.current = null;
    setIncomingFile((current) => {
      if (current?.downloadUrl) {
        URL.revokeObjectURL(current.downloadUrl);
      }

      return null;
    });
  }

  function attachDataChannel(channel: RTCDataChannel) {
    dataChannelRef.current = channel;
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

        if (message.type === 'file-meta') {
          const payload = (message as FileMetaPeerMessage).payload;
          incomingTransferIdRef.current = message.transferId;
          incomingChunksRef.current = [];
          setIncomingFile((current) => {
            if (current?.downloadUrl) {
              URL.revokeObjectURL(current.downloadUrl);
            }

            return {
              transferId: message.transferId,
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
          const payload = (message as FileCompletePeerMessage).payload;
          if (!incomingTransferIdRef.current || incomingTransferIdRef.current !== message.transferId) {
            pushErrorToast('Transfer complete received without matching metadata');
            return;
          }

          const blob = new Blob(incomingChunksRef.current, {
            type: incomingFile?.mimeType ?? 'application/octet-stream',
          });

          if (blob.size !== payload.totalBytes) {
            pushErrorToast('Received file size does not match metadata');
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
              downloadUrl,
            };
          });
          setTransferStatus('File received');
        }

        return;
      }

      if (event.data instanceof ArrayBuffer) {
        incomingChunksRef.current.push(event.data);
        setIncomingFile((current) => {
          if (!current) {
            return current;
          }

          return {
            ...current,
            receivedBytes: current.receivedBytes + event.data.byteLength,
          };
        });
        return;
      }

      if (event.data instanceof Blob) {
        void event.data.arrayBuffer().then((buffer) => {
          incomingChunksRef.current.push(buffer);
          setIncomingFile((current) => {
            if (!current) {
              return current;
            }

            return {
              ...current,
              receivedBytes: current.receivedBytes + buffer.byteLength,
            };
          });
        });
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
      transferId: crypto.randomUUID(),
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

    if (selectedFile.size > MAX_FILE_SIZE_BYTES) {
      pushErrorToast('File is larger than 10 MB limit');
      setTransferStatus('Send failed: file too large');
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
      setTransferStatus(`Sending ${selectedFile.name}`);

      sendControlMessage({
        type: 'file-meta',
        transferId,
        payload: {
          fileName: selectedFile.name,
          fileSize: selectedFile.size,
          mimeType: selectedFile.type || 'application/octet-stream',
        },
      });

      const fileBuffer = await selectedFile.arrayBuffer();
      channel.send(fileBuffer);

      sendControlMessage({
        type: 'file-complete',
        transferId,
        payload: {
          totalBytes: fileBuffer.byteLength,
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
        <h2>Small File Transfer (Phase 4)</h2>
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
        <p className="transfer-note">Limit: 10 MB per file</p>
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
