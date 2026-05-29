import { env } from './env.js';

export const corsConfig = {
  origin: env.clientOrigin,
  credentials: true,
};
