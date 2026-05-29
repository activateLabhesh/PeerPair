export const socketEvents = {
  ping: 'ping',
  pong: 'pong',
  createRoom: 'create-room',
  roomCreated: 'room-created',
  joinRoom: 'join-room',
  roomJoined: 'room-joined',
  leaveRoom: 'leave-room',
  userJoined: 'user-joined',
  userLeft: 'user-left',
  offer: 'offer',
  answer: 'answer',
  iceCandidate: 'ice-candidate',
} as const;
