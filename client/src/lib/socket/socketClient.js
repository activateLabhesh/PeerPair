import { io } from 'socket.io-client';
const socketServerUrl = import.meta.env.VITE_SOCKET_SERVER_URL ?? 'http://localhost:4000';
export const socketClient = io(socketServerUrl, {
    autoConnect: true,
    transports: ['websocket'],
});
