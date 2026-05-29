import { iceConfig } from './iceConfig';
export function createPeerConnection() {
    return new RTCPeerConnection(iceConfig);
}
