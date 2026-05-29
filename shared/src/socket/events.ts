import type { AckResponse, RoomStatePayload, SignalPayload } from './payloads';

export type ClientToServerEvents = {
  'create-room': (ack?: (response: AckResponse) => void) => void;
  'join-room': (roomId: string, ack?: (response: AckResponse) => void) => void;
  'leave-room': (roomId: string, ack?: (response: AckResponse) => void) => void;
  offer: (payload: SignalPayload) => void;
  answer: (payload: SignalPayload) => void;
  'ice-candidate': (payload: SignalPayload) => void;
  ping: (message: string, ack?: (response: { message: string }) => void) => void;
};

export type ServerToClientEvents = {
  'room-created': (payload: RoomStatePayload) => void;
  'room-joined': (payload: RoomStatePayload) => void;
  'user-joined': (peerId: string) => void;
  'user-left': (peerId: string) => void;
  offer: (payload: SignalPayload) => void;
  answer: (payload: SignalPayload) => void;
  'ice-candidate': (payload: SignalPayload) => void;
  pong: (message: string) => void;
};
