export type ProtocolEnvelope<TPayload> = {
  type: string;
  transferId: string;
  payload: TPayload;
};
