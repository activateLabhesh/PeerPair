import { createServer } from 'node:http';
import { app } from './app.js';
import { env } from './config/env.js';
import { logger } from './logger/index.js';
import { createSocketServer } from './socket/index.js';

const httpServer = createServer(app);

createSocketServer(httpServer);

httpServer.listen(env.port, () => {
  logger.info(`Server listening on http://localhost:${env.port}`);
});
