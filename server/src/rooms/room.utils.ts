export function createRoomId(): string {
  return crypto.randomUUID().slice(0, 6).toUpperCase();
}
