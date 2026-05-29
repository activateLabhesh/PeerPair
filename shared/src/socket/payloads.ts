export type RoomPayload = {
  roomId: string;
  peerId: string;
};

export type RoomStatePayload = {
  roomId: string;
  peers: string[];
  hostPeerId: string;
};

export type SignalPayload = {
  roomId: string;
  fromPeerId: string;
  data: unknown;
};

export type AckResponse = {
  ok: boolean;
  message?: string;
};
