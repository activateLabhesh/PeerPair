import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useRef, useState } from 'react';
import { socketClient } from './lib/socket/socketClient';
import { socketEvents } from './lib/socket/socketEvents';
import { createDataChannel } from './lib/webrtc/dataChannel';
import { createPeerConnection } from './lib/webrtc/peerConnection';
import './styles/global.css';
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
export function App() {
    const [socketId, setSocketId] = useState(socketClient.id ?? null);
    const [isConnected, setIsConnected] = useState(socketClient.connected);
    const [pongMessage, setPongMessage] = useState('waiting');
    const [roomId, setRoomId] = useState('');
    const [joinedRoomId, setJoinedRoomId] = useState(null);
    const [peers, setPeers] = useState([]);
    const [statusMessage, setStatusMessage] = useState('Idle');
    const [rtcState, setRtcState] = useState('new');
    const [channelState, setChannelState] = useState('closed');
    const [chatMessage, setChatMessage] = useState('');
    const [chatLog, setChatLog] = useState([]);
    const [toasts, setToasts] = useState([]);
    const [selectedFile, setSelectedFile] = useState(null);
    const [transferStatus, setTransferStatus] = useState('Idle');
    const [incomingFile, setIncomingFile] = useState(null);
    const peerConnectionRef = useRef(null);
    const dataChannelRef = useRef(null);
    const incomingChunksRef = useRef([]);
    const incomingTransferIdRef = useRef(null);
    function safeParsePeerMessage(raw) {
        try {
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || !('type' in parsed)) {
                return null;
            }
            return parsed;
        }
        catch {
            return null;
        }
    }
    function sendControlMessage(message) {
        const channel = dataChannelRef.current;
        if (!channel || channel.readyState !== 'open') {
            throw new Error('DataChannel is not open');
        }
        channel.send(JSON.stringify(message));
    }
    function addChatLog(message) {
        setChatLog((current) => [...current, message]);
    }
    function removeToast(id) {
        setToasts((current) => current.filter((toast) => toast.id !== id));
    }
    function pushErrorToast(message) {
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
    function attachDataChannel(channel) {
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
                    const payload = message.payload;
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
                    const payload = message.payload;
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
    function ensurePeerConnection(activeRoomId) {
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
    async function createAndSendOffer(activeRoomId) {
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
        function onRoomState(payload) {
            setJoinedRoomId(payload.roomId);
            setRoomId(payload.roomId);
            setPeers(payload.peers);
            setStatusMessage(`In room ${payload.roomId}`);
            ensurePeerConnection(payload.roomId);
        }
        function onUserJoined(peerId) {
            setPeers((currentPeers) => {
                if (currentPeers.includes(peerId)) {
                    return currentPeers;
                }
                return [...currentPeers, peerId];
            });
        }
        function onUserLeft(peerId) {
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
        async function onOffer(payload) {
            if (!joinedRoomId || payload.roomId !== joinedRoomId) {
                return;
            }
            try {
                const peerConnection = ensurePeerConnection(payload.roomId);
                await peerConnection.setRemoteDescription(payload.data);
                const answer = await peerConnection.createAnswer();
                await peerConnection.setLocalDescription(answer);
                socketClient.emit(socketEvents.answer, {
                    roomId: payload.roomId,
                    fromPeerId: socketClient.id ?? '',
                    data: answer,
                });
                setStatusMessage(`Received offer from ${payload.fromPeerId}`);
            }
            catch {
                pushErrorToast('Failed to process incoming offer');
            }
        }
        async function onAnswer(payload) {
            if (!joinedRoomId || payload.roomId !== joinedRoomId || !peerConnectionRef.current) {
                return;
            }
            try {
                await peerConnectionRef.current.setRemoteDescription(payload.data);
                setStatusMessage(`Received answer from ${payload.fromPeerId}`);
            }
            catch {
                pushErrorToast('Failed to apply answer');
            }
        }
        async function onIceCandidate(payload) {
            if (!joinedRoomId || payload.roomId !== joinedRoomId || !peerConnectionRef.current) {
                return;
            }
            try {
                await peerConnectionRef.current.addIceCandidate(payload.data);
            }
            catch {
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
        const textMessage = {
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
        }
        catch {
            pushErrorToast('Failed to send file');
            setTransferStatus('Send failed');
        }
    }
    useEffect(() => {
        function onConnect() {
            setIsConnected(true);
            setSocketId(socketClient.id ?? null);
            socketClient.emit(socketEvents.ping, 'hello-phase-0', (response) => {
                setPongMessage(response.message);
            });
        }
        function onDisconnect() {
            setIsConnected(false);
            setSocketId(null);
        }
        function onPong(message) {
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
    return (_jsxs("main", { className: "app-shell", children: [_jsx("aside", { className: "toast-stack", "aria-live": "polite", children: toasts.map((toast) => (_jsxs("div", { className: "toast toast-error", children: [_jsx("span", { children: toast.message }), _jsx("button", { className: "toast-close", onClick: () => removeToast(toast.id), children: "x" })] }, toast.id))) }), _jsxs("section", { className: "hero-card", children: [_jsx("p", { className: "eyebrow", children: "PeerPair / Phase 2" }), _jsx("h1", { children: "Realtime Peer Signaling Playground" }), _jsx("p", { className: "hero-copy", children: "Create a room, join with a second browser, and watch signaling + DataChannel state update live." })] }), _jsxs("section", { className: "panel room-panel", children: [_jsx("h2", { children: "Room Control" }), _jsxs("div", { className: "room-actions", children: [_jsx("button", { className: "btn primary", onClick: handleCreateRoom, children: "Create Room" }), _jsx("button", { className: "btn", onClick: handleJoinRoom, children: "Join Room" }), _jsx("button", { className: "btn danger", onClick: handleLeaveRoom, children: "Leave Room" })] }), _jsx("input", { className: "field", type: "text", placeholder: "Enter room ID", value: roomId, onChange: (event) => setRoomId(event.target.value) }), _jsxs("div", { className: "badge-row", children: [_jsxs("span", { className: "badge", children: ["Active: ", joinedRoomId ?? 'None'] }), _jsxs("span", { className: "badge", children: ["Peers: ", peers.length] })] })] }), _jsxs("section", { className: "panel grid-panel", children: [_jsxs("div", { className: "status-tile", children: [_jsx("p", { className: "label", children: "Socket" }), _jsx("p", { className: `value ${isConnected ? 'ok' : 'bad'}`, children: isConnected ? 'Connected' : 'Disconnected' })] }), _jsxs("div", { className: "status-tile", children: [_jsx("p", { className: "label", children: "WebRTC" }), _jsx("p", { className: "value", children: rtcState })] }), _jsxs("div", { className: "status-tile", children: [_jsx("p", { className: "label", children: "DataChannel" }), _jsx("p", { className: "value", children: channelState })] }), _jsxs("div", { className: "status-tile", children: [_jsx("p", { className: "label", children: "Room Status" }), _jsx("p", { className: "value", children: statusMessage })] })] }), _jsxs("section", { className: "panel chat-panel", children: [_jsx("h2", { children: "DataChannel Chat" }), _jsxs("div", { className: "chat-row", children: [_jsx("input", { className: "field", type: "text", placeholder: "Send message over DataChannel", value: chatMessage, onChange: (event) => setChatMessage(event.target.value) }), _jsx("button", { className: "btn primary", onClick: handleSendMessage, children: "Send" })] }), _jsxs("div", { className: "log-box", children: [chatLog.length === 0 ? _jsx("p", { className: "log-empty", children: "No messages yet" }) : null, chatLog.map((entry, index) => (_jsx("p", { className: "log-line", children: entry }, `${entry}-${index}`)))] })] }), _jsxs("section", { className: "panel transfer-panel", children: [_jsx("h2", { children: "Small File Transfer (Phase 4)" }), _jsxs("div", { className: "transfer-row", children: [_jsx("input", { className: "field", type: "file", onChange: (event) => {
                                    setSelectedFile(event.target.files?.[0] ?? null);
                                } }), _jsx("button", { className: "btn primary", onClick: () => void handleSendFile(), children: "Send File" })] }), _jsx("p", { className: "transfer-note", children: "Limit: 10 MB per file" }), _jsxs("p", { className: "transfer-note", children: ["Transfer status: ", transferStatus] }), selectedFile ? (_jsxs("p", { className: "transfer-note", children: ["Selected: ", selectedFile.name, " (", Math.ceil(selectedFile.size / 1024), " KB)"] })) : null, incomingFile ? (_jsxs("div", { className: "incoming-card", children: [_jsxs("p", { children: ["Incoming: ", incomingFile.fileName] }), _jsxs("p", { children: ["Received: ", incomingFile.receivedBytes, " / ", incomingFile.fileSize, " bytes"] }), incomingFile.downloadUrl ? (_jsx("a", { className: "btn", href: incomingFile.downloadUrl, download: incomingFile.fileName, children: "Download Received File" })) : null] })) : null] }), _jsxs("footer", { className: "meta", children: [_jsxs("span", { children: ["Socket ID: ", socketId ?? 'N/A'] }), _jsxs("span", { children: ["Handshake: ", pongMessage] })] })] }));
}
