export type TextPeerMessage = {
  type: 'text';
  transferId: string;
  payload: {
    message: string;
  };
};

export type FileMetaPeerMessage = {
  type: 'file-meta';
  transferId: string;
  payload: {
    fileName: string;
    fileSize: number;
    mimeType: string;
  };
};

export type FileCompletePeerMessage = {
  type: 'file-complete';
  transferId: string;
  payload: {
    totalBytes: number;
  };
};

export type PeerMessage = TextPeerMessage | FileMetaPeerMessage | FileCompletePeerMessage;
