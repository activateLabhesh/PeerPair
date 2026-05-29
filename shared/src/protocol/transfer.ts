export type TransferStatus = 'idle' | 'preparing' | 'sending' | 'receiving' | 'completed' | 'failed';

export type ChunkMetadata = {
  transferId: string;
  index: number;
  total: number;
  size: number;
};
