import type { Server as HttpServer } from 'node:http';
import type { ClientToServerEvents, ServerToClientEvents } from '@peerpair/shared';
import { Server } from 'socket.io';
import { corsConfig } from '../config/cors.js';
import { logger } from '../logger/index.js';
import { createRoomId } from '../rooms/room.utils.js';
import { roomManager } from '../rooms/roomManager.js';

function isSocketInRoom(roomId: string, socketId: string): boolean {
  const peers = roomManager.getPeers(roomId);
  return peers.includes(socketId);
}

export function createSocketServer(httpServer: HttpServer): Server<ClientToServerEvents, ServerToClientEvents> {
  const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
    cors: corsConfig,
  });

  io.on('connection', (socket) => {
    logger.info('[socket] connected', socket.id);

    socket.on('ping', (message: string, ack?: (response: { message: string }) => void) => {
      const response = `pong:${message}`;
      socket.emit('pong', response);
      ack?.({ message: response });
    });


    socket.on('create-room', (ack) => {
      const roomId = createRoomId();
      const room = roomManager.createRoom(roomId, socket.id);
      socket.join(room.roomId);

      logger.info('[room] created', { roomId: room.roomId, socketId: socket.id });
      socket.emit('room-created', {
        roomId: room.roomId,
        peers: room.peers,
        hostPeerId: room.hostPeerId,
      });
      ack?.({ ok: true, message: room.roomId });
    });

    socket.on('join-room', (roomId: string, ack) => {
      const normalizedRoomId = roomId.trim().toUpperCase();

      if (!normalizedRoomId) {
        ack?.({ ok: false, message: 'Room ID is required' });
        return;
      }

      const room = roomManager.getRoom(normalizedRoomId);
      if (!room) {
        ack?.({ ok: false, message: 'Room not found' });
        return;
      }

      if (roomManager.isRoomFull(normalizedRoomId, 2)) {
        ack?.({ ok: false, message: 'Room is full' });
        return;
      }

      const result = roomManager.addPeer(normalizedRoomId, socket.id);
      if (!result.ok) {
        ack?.(result);
        return;
      }

      socket.join(normalizedRoomId);
      socket.emit('room-joined', {
        roomId: normalizedRoomId,
        peers: roomManager.getPeers(normalizedRoomId),
        hostPeerId: room.hostPeerId,
      });
      socket.to(normalizedRoomId).emit('user-joined', socket.id);

      logger.info('[room] joined', { roomId: normalizedRoomId, socketId: socket.id });
      ack?.({ ok: true, message: 'Joined room successfully' });
    });

    socket.on('leave-room', (roomId: string, ack) => {
      const normalizedRoomId = roomId.trim().toUpperCase();
      const room = roomManager.getRoom(normalizedRoomId);

      if (!room) {
        ack?.({ ok: false, message: 'Room not found' });
        return;
      }

      roomManager.removePeer(normalizedRoomId, socket.id);
      socket.leave(normalizedRoomId);
      socket.to(normalizedRoomId).emit('user-left', socket.id);

      logger.info('[room] left', { roomId: normalizedRoomId, socketId: socket.id });
      ack?.({ ok: true, message: 'Left room successfully' });
    });

    socket.on('offer', (payload) => {
      const roomId = payload.roomId.trim().toUpperCase();
      if (!roomManager.getRoom(roomId)) {
        logger.error('[signal] offer rejected: room not found', { roomId, socketId: socket.id });
        return;
      }

      if (!isSocketInRoom(roomId, socket.id)) {
        logger.error('[signal] offer rejected: peer not in room', { roomId, socketId: socket.id });
        return;
      }

      socket.to(roomId).emit('offer', { ...payload, roomId, fromPeerId: socket.id });
    });

    socket.on('answer', (payload) => {
      const roomId = payload.roomId.trim().toUpperCase();
      if (!roomManager.getRoom(roomId)) {
        logger.error('[signal] answer rejected: room not found', { roomId, socketId: socket.id });
        return;
      }

      if (!isSocketInRoom(roomId, socket.id)) {
        logger.error('[signal] answer rejected: peer not in room', { roomId, socketId: socket.id });
        return;
      }

      socket.to(roomId).emit('answer', { ...payload, roomId, fromPeerId: socket.id });
    });

    socket.on('ice-candidate', (payload) => {
      const roomId = payload.roomId.trim().toUpperCase();
      if (!roomManager.getRoom(roomId)) {
        logger.error('[signal] ice-candidate rejected: room not found', { roomId, socketId: socket.id });
        return;
      }

      if (!isSocketInRoom(roomId, socket.id)) {
        logger.error('[signal] ice-candidate rejected: peer not in room', { roomId, socketId: socket.id });
        return;
      }

      socket.to(roomId).emit('ice-candidate', { ...payload, roomId, fromPeerId: socket.id });
    });

    socket.on('disconnect', (reason) => {
      const room = roomManager.findRoomByPeer(socket.id);
      if (room) {
        roomManager.removePeer(room.roomId, socket.id);
        socket.to(room.roomId).emit('user-left', socket.id);
        logger.info('[room] peer disconnected', { roomId: room.roomId, socketId: socket.id });
      }

      logger.info('[socket] disconnected', socket.id, reason);
    });
  });

  return io;
}
