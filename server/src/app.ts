import cors from 'cors';
import express from 'express';
import { corsConfig } from './config/cors.js';

export const app = express();

app.use(cors(corsConfig));
app.use(express.json());

app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true });
});
