export type TextPeerMessage = {
  type: 'text';
  payload: {
    message: string;
  };
};

export type FileMetadataPeerMessage = {
  type: 'file-metadata';
  payload: {
    transferId: string;
    fileName: string;
    fileSize: number;
    mimeType: string;
  };
};

export type FileCompletePeerMessage = {
  type: 'file-complete';
  payload: {
    transferId: string;
    totalBytes: number;
  };
};

export type PeerMessage =
  | TextPeerMessage
  | FileMetadataPeerMessage
  | FileCompletePeerMessage;
