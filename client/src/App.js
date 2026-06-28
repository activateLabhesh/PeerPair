import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useRef, useState } from 'react';
import { socketClient } from './lib/socket/socketClient';
import { socketEvents } from './lib/socket/socketEvents';
import { createDataChannel } from './lib/webrtc/dataChannel';
import { createPeerConnection } from './lib/webrtc/peerConnection';
import './styles/global.css';
const CHUNK_SIZE_BYTES = 256 * 1024;
const BUFFER_HIGH_WATERMARK_BYTES = 4 * 1024 * 1024;
const BUFFER_LOW_WATERMARK_BYTES = 1 * 1024 * 1024;
const UI_UPDATE_INTERVAL_MS = 150;
const MAX_CONNECTION_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 1200;
const DATA_CHANNEL_OPEN_TIMEOUT_MS = 12000;
export function App() {
    const [currentPage, setCurrentPage] = useState('home');
    const [isConnected, setIsConnected] = useState(socketClient.connected);
    const [roomId, setRoomId] = useState('');
    const [joinedRoomId, setJoinedRoomId] = useState(null);
    const [peers, setPeers] = useState([]);
    const [statusMessage, setStatusMessage] = useState('Idle');
    const [rtcState, setRtcState] = useState('new');
    const [channelState, setChannelState] = useState('closed');
    const [chatLog, setChatLog] = useState([]);
    const [toasts, setToasts] = useState([]);
    const [selectedFile, setSelectedFile] = useState(null);
    const [transferStatus, setTransferStatus] = useState('Idle');
    const [incomingFile, setIncomingFile] = useState(null);
    const [transferMetrics, setTransferMetrics] = useState(null);
    const peerConnectionRef = useRef(null);
    const dataChannelRef = useRef(null);
    const incomingTransfersRef = useRef(new Map());
    const lastIncomingUiUpdateRef = useRef(0);
    const lastOutgoingUiUpdateRef = useRef(0);
    const retryAttemptRef = useRef(0);
    const retryTimerRef = useRef(null);
    const dataChannelOpenTimerRef = useRef(null);
    const isIntentionalLeaveRef = useRef(false);
    const retryInProgressRef = useRef(false);
    const shouldCreateOfferRef = useRef(false);
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
    function toMbps(totalBytes, durationMs) {
        if (durationMs <= 0) {
            return 0;
        }
        const bits = totalBytes * 8;
        return bits / (durationMs / 1000) / 1_000_000;
    }
    function formatBytes(totalBytes) {
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
    function waitForBufferToDrain(channel) {
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
    function scheduleReconnect(reason) {
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
            }
            else {
                ensurePeerConnection(joinedRoomId);
            }
        }, delay);
    }
    function cleanupPeerConnection() {
        resetRetryState();
        cleanupConnectionOnly();
        clearIncomingTransfers();
    }
    function attachDataChannel(channel) {
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
                    const payload = message.payload;
                    setTransferMetrics(null);
                    const incomingTransfer = {
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
            const processBinaryChunk = (buffer) => {
                const transfer = Array.from(incomingTransfersRef.current.values())[0];
                if (!transfer) {
                    pushErrorToast('Binary chunk received for unknown transfer');
                    return;
                }
                transfer.chunks.push(buffer);
                transfer.receivedBytes += buffer.byteLength;
                const now = performance.now();
                const shouldUpdateUi = now - lastIncomingUiUpdateRef.current >= UI_UPDATE_INTERVAL_MS || transfer.receivedBytes >= transfer.fileSize;
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
                    }
                    catch {
                        pushErrorToast('Failed to send file-complete');
                    }
                    const downloadUrl = URL.createObjectURL(blob);
                    setIncomingFile((current) => {
                        if (!current)
                            return current;
                        if (current.downloadUrl)
                            URL.revokeObjectURL(current.downloadUrl);
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
    async function createAndSendOffer(activeRoomId) {
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
        function onRoomState(payload) {
            isIntentionalLeaveRef.current = false;
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
                shouldCreateOfferRef.current = false;
                const peerConnection = ensurePeerConnection(payload.roomId);
                await peerConnection.setRemoteDescription(payload.data);
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
        }
        catch {
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
    const homePage = (_jsxs(_Fragment, { children: [_jsxs("section", { className: "hero-card home-hero", children: [_jsxs("div", { className: "hero-content", children: [_jsxs("p", { className: "eyebrow", children: [_jsx("span", { className: "brand-mark", children: "PP" }), " PeerPair"] }), _jsxs("h1", { children: ["Private file sharing, ", _jsx("span", { children: "directly" }), " between browsers"] }), _jsx("p", { className: "hero-copy", children: "PeerPair lets two people connect in a shared room and transfer files directly, with a simple workflow built for fast, secure handoffs." }), _jsx("div", { className: "room-actions hero-actions", children: _jsxs("button", { className: "btn primary hero-cta", onClick: () => setCurrentPage('share'), children: [_jsx("span", { "aria-hidden": "true", children: "\u21A5" }), " Share Files"] }) })] }), _jsxs("div", { className: "hero-visual", "aria-hidden": "true", children: [_jsx("div", { className: "orbit orbit-left" }), _jsx("div", { className: "orbit orbit-right" }), _jsx("div", { className: "spark spark-one", children: "\u2726" }), _jsx("div", { className: "spark spark-two", children: "\u25C6" }), _jsx("div", { className: "spark spark-three", children: "\u2726" }), _jsxs("div", { className: "file-card", children: [_jsx("span", {}), _jsx("span", {}), _jsx("span", {})] }), _jsx("div", { className: "transfer-arc" }), _jsx("div", { className: "check-bubble", children: "\u2713" }), _jsxs("div", { className: "laptop laptop-left", children: [_jsxs("div", { className: "laptop-screen", children: [_jsx("div", { className: "avatar avatar-yellow", children: "\u25CF" }), _jsx("strong", { children: "You" })] }), _jsx("div", { className: "laptop-base" })] }), _jsxs("div", { className: "laptop laptop-right", children: [_jsxs("div", { className: "laptop-screen", children: [_jsx("div", { className: "avatar avatar-teal", children: "\u25CF" }), _jsx("strong", { children: "Peer" })] }), _jsx("div", { className: "laptop-base" })] })] })] }), _jsxs("section", { className: "feature-grid", children: [_jsxs("article", { className: "panel feature-card feature-yellow", children: [_jsx("div", { className: "feature-icon", children: "\u03DF" }), _jsxs("div", { children: [_jsx("h2", { children: "Direct Transfer" }), _jsx("span", { className: "feature-rule" }), _jsx("p", { className: "hero-copy feature-copy", children: "Files move from one browser to another without uploading them into a separate storage workflow." })] })] }), _jsxs("article", { className: "panel feature-card feature-teal", children: [_jsx("div", { className: "feature-icon", children: "\u260A" }), _jsxs("div", { children: [_jsx("h2", { children: "Simple Session Flow" }), _jsx("span", { className: "feature-rule" }), _jsx("p", { className: "hero-copy feature-copy", children: "Create a room, share the room code, and start sending files as soon as the second participant joins." })] })] }), _jsxs("article", { className: "panel feature-card feature-purple", children: [_jsx("div", { className: "feature-icon", children: "\u25A5" }), _jsxs("div", { children: [_jsx("h2", { children: "Live Progress" }), _jsx("span", { className: "feature-rule" }), _jsx("p", { className: "hero-copy feature-copy", children: "Track session status, transfer progress, and completed downloads in a single workspace." })] })] })] })] }));
    const sharePage = (_jsxs(_Fragment, { children: [_jsxs("section", { className: "hero-card", children: [_jsx("p", { className: "eyebrow", children: "PeerPair" }), _jsx("h1", { children: "Secure File Sharing Workspace" }), _jsx("p", { className: "hero-copy", children: "Start a room, invite the other participant with the room code, and send files once the connection is ready." }), _jsx("div", { className: "room-actions hero-actions", children: _jsx("button", { className: "btn", onClick: () => setCurrentPage('home'), children: "Home" }) })] }), _jsxs("section", { className: "panel room-panel", children: [_jsx("h2", { children: "Room Access" }), _jsxs("div", { className: "room-actions", children: [_jsx("button", { className: "btn primary", onClick: handleCreateRoom, children: "Create Room" }), _jsx("button", { className: "btn", onClick: handleJoinRoom, children: "Join Room" }), _jsx("button", { className: "btn danger", onClick: handleLeaveRoom, children: "Leave Room" })] }), _jsx("input", { className: "field", type: "text", placeholder: "Enter room ID", value: roomId, onChange: (event) => setRoomId(event.target.value) }), _jsxs("div", { className: "badge-row", children: [_jsxs("span", { className: "badge", children: ["Active Room: ", joinedRoomId ?? 'None'] }), _jsxs("span", { className: "badge", children: ["Participants: ", peers.length] })] })] }), _jsxs("section", { className: "panel grid-panel", children: [_jsxs("div", { className: "status-tile", children: [_jsx("p", { className: "label", children: "Service Link" }), _jsx("p", { className: `value ${isConnected ? 'ok' : 'bad'}`, children: isConnected ? 'Connected' : 'Disconnected' })] }), _jsxs("div", { className: "status-tile", children: [_jsx("p", { className: "label", children: "Connection State" }), _jsx("p", { className: "value", children: rtcState })] }), _jsxs("div", { className: "status-tile", children: [_jsx("p", { className: "label", children: "Transfer Channel" }), _jsx("p", { className: "value", children: channelState })] }), _jsxs("div", { className: "status-tile", children: [_jsx("p", { className: "label", children: "Session Status" }), _jsx("p", { className: "value", children: statusMessage })] })] }), _jsxs("section", { className: "panel transfer-panel", children: [_jsx("h2", { children: "Send Files" }), _jsxs("div", { className: "transfer-row", children: [_jsx("input", { className: "field", type: "file", onChange: (event) => {
                                    setSelectedFile(event.target.files?.[0] ?? null);
                                } }), _jsx("button", { className: "btn primary", onClick: () => void handleSendFile(), children: "Send File" })] }), _jsxs("p", { className: "transfer-note", children: ["Transfer status: ", transferStatus] }), transferMetrics ? (_jsxs("p", { className: "transfer-note", children: ["Last ", transferMetrics.direction, ": ", transferMetrics.fileName, " at ", transferMetrics.speedMbps.toFixed(2), " Mbps in", ' ', (transferMetrics.durationMs / 1000).toFixed(2), "s", typeof transferMetrics.peakBufferedAmount === 'number'
                                ? ` (peak buffer ${Math.round(transferMetrics.peakBufferedAmount / 1024)} KB)`
                                : ''] })) : null, selectedFile ? (_jsxs("p", { className: "transfer-note", children: ["Selected: ", selectedFile.name, " (", formatBytes(selectedFile.size), ")"] })) : null, incomingFile ? (_jsxs("div", { className: "incoming-card", children: [_jsxs("p", { children: ["Incoming file: ", incomingFile.fileName] }), _jsxs("p", { children: ["Received: ", formatBytes(incomingFile.receivedBytes), " / ", formatBytes(incomingFile.fileSize)] }), incomingFile.downloadUrl ? (_jsx("a", { className: "btn", href: incomingFile.downloadUrl, download: incomingFile.fileName, children: "Download File" })) : null] })) : null] }), _jsxs("section", { className: "panel chat-panel", children: [_jsx("h2", { children: "Session Activity" }), _jsxs("div", { className: "log-box", children: [chatLog.length === 0 ? _jsx("p", { className: "log-empty", children: "No session activity yet" }) : null, chatLog.map((entry, index) => (_jsx("p", { className: "log-line", children: entry }, `${entry}-${index}`)))] })] })] }));
    return (_jsxs("main", { className: "app-shell", children: [_jsx("aside", { className: "toast-stack", "aria-live": "polite", children: toasts.map((toast) => (_jsxs("div", { className: "toast toast-error", children: [_jsx("span", { children: toast.message }), _jsx("button", { className: "toast-close", onClick: () => removeToast(toast.id), children: "x" })] }, toast.id))) }), currentPage === 'home' ? homePage : sharePage] }));
}
