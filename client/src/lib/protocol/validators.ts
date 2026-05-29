export function isValidEnvelope(value: unknown): boolean {
  return typeof value === 'object' && value !== null;
}
