export function createDataChannel(peer: RTCPeerConnection): RTCDataChannel {
  return peer.createDataChannel('peerpair');
}
