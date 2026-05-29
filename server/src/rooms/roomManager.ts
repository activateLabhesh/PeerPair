import type { RoomState } from './room.types.js';

const rooms = new Map<string, RoomState>();

function normalizeRoomId(roomId: string): string {
  return roomId.trim().toUpperCase();
}

function createRoom(roomId: string, hostPeerId: string): RoomState {
  const normalizedRoomId = normalizeRoomId(roomId);
  const room: RoomState = {
    roomId: normalizedRoomId,
    hostPeerId,
    peers: [hostPeerId],
  };

  rooms.set(normalizedRoomId, room);
  return room;
}

function getRoom(roomId: string): RoomState | undefined {
  return rooms.get(normalizeRoomId(roomId));
}

function getPeers(roomId: string): string[] {
  return getRoom(roomId)?.peers ?? [];
}

function addPeer(roomId: string, peerId: string): { ok: boolean; message?: string } {
  const room = getRoom(roomId);
  if (!room) {
    return { ok: false, message: 'Room not found' };
  }

  if (room.peers.includes(peerId)) {
    return { ok: true, message: 'Peer already in room' };
  }

  room.peers.push(peerId);
  return { ok: true };
}

function removePeer(roomId: string, peerId: string): void {
  const room = getRoom(roomId);
  if (!room) {
    return;
  }

  room.peers = room.peers.filter((peer) => peer !== peerId);

  if (room.hostPeerId === peerId) {
    room.hostPeerId = room.peers[0] ?? '';
  }

  if (room.peers.length === 0) {
    rooms.delete(room.roomId);
  }
}

function deleteRoom(roomId: string): void {
  rooms.delete(normalizeRoomId(roomId));
}

function isRoomFull(roomId: string, maxPeers = 2): boolean {
  const room = getRoom(roomId);
  if (!room) {
    return false;
  }

  return room.peers.length >= maxPeers;
}

function findRoomByPeer(peerId: string): RoomState | undefined {
  for (const room of rooms.values()) {
    if (room.peers.includes(peerId)) {
      return room;
    }
  }

  return undefined;
}

function getRooms(): RoomState[] {
  return Array.from(rooms.values());
}

export const roomManager = {
  createRoom,
  getRoom,
  getRooms,
  getPeers,
  addPeer,
  removePeer,
  deleteRoom,
  isRoomFull,
  findRoomByPeer,
};
