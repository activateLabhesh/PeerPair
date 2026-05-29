import type { ClientToServerEvents, ServerToClientEvents } from '@peerpair/shared';
import { io, type Socket } from 'socket.io-client';

const socketServerUrl = import.meta.env.VITE_SOCKET_SERVER_URL ?? 'http://localhost:4000';

export const socketClient: Socket<ServerToClientEvents, ClientToServerEvents> = io(socketServerUrl, {
  autoConnect: true,
  transports: ['websocket'],
});
