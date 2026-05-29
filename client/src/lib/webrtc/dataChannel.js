export function createDataChannel(peer) {
    return peer.createDataChannel('peerpair');
}
