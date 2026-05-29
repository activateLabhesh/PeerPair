import { iceConfig } from './iceConfig';

export function createPeerConnection(): RTCPeerConnection {
  return new RTCPeerConnection(iceConfig);
}
