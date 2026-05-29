export type TextPeerMessage = {
  type: 'text';
  payload: {
    message: string;
  };
};


export type FileStartPeerMessage = {
  type: 'file-start';
  payload: {
    transferId: string;
    fileName: string;
    fileSize: number;
    mimeType: string;
    chunkSize: number;
    totalChunks: number;
  };
};

export type FileChunkPeerMessage = {
  type: 'file-chunk';
  payload: {
    transferId: string;
    chunkIndex: number; // 0-based
    totalChunks: number;
    byteOffset: number;
    chunkByteLength: number;
    // actual binary bytes are sent as ArrayBuffer/Blob in a separate DataChannel message
  };
};

export type FileAckPeerMessage = {
  type: 'file-ack';
  payload: {
    transferId: string;
    receivedUpToChunkIndex: number; // highest contiguous chunk received by receiver
    receivedBytes: number;
  };
};

export type FileErrorPeerMessage = {
  type: 'file-error';
  payload: {
    transferId: string;
    code:
      | 'TRANSFER_NOT_FOUND'
      | 'INVALID_CHUNK_INDEX'
      | 'SIZE_MISMATCH'
      | 'TIMEOUT'
      | 'INTERNAL_ERROR';
    message: string;
  };
};

export type FileCompletePeerMessage = {
  type: 'file-complete';
  payload: {
    transferId: string;
    totalBytes: number;
    totalChunks: number;
  };
};

export type FileCancelPeerMessage = {
  type: 'file-cancel';
  payload: {
    transferId: string;
    reason?: string;
  };
};

export type PeerMessage =
  | TextPeerMessage
  | FileStartPeerMessage
  | FileChunkPeerMessage
  | FileAckPeerMessage
  | FileCompletePeerMessage
  | FileErrorPeerMessage
  | FileCancelPeerMessage;
