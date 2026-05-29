export type PeerMessage = {
  type: 'text' | 'file-meta' | 'file-chunk' | 'file-complete';
  transferId: string;
  payload: unknown;
};
