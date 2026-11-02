import 'reflect-metadata';
import { config as loadDotenv } from 'dotenv';
import { ENV_FILE } from './config/paths';

// Loaded before anything imports the env schema, and from the package root so
// the server behaves identically whatever directory it was started from.
loadDotenv({ path: ENV_FILE, quiet: true });

import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { json, urlencoded } from 'express';
import { WsAdapter } from '@nestjs/platform-ws';
import { Logger } from '@nestjs/common';
import { isTestDatabaseName } from '@orvia/shared';
import { AppModule } from './app.module';
import { ENV, type Env } from './config/env';
import { ZodExceptionFilter } from './common/zod-exception.filter';

/**
 * Body size limit. Set to 2MB to comfortably accommodate large profile payloads
 * (which exceed Express's 100KB default) while maintaining a bounded memory footprint.
 */
const MAX_BODY = '2mb';

async function bootstrap() {
  // `bodyParser: false` so the limit below is the one that applies. Registering
  // a second parser after Nest's own does nothing — Express marks the body as
  // read, and the default 100KB would still be what rejects the request.
  const app = await NestFactory.create(AppModule, { bufferLogs: false, bodyParser: false });
  const env = app.get<Env>(ENV);

  app.use(json({ limit: MAX_BODY }));
  app.use(urlencoded({ extended: true, limit: MAX_BODY }));

  // Raw `ws` rather than socket.io: this connection carries a continuous PCM
  // stream, and socket.io's framing and heartbeats add latency we cannot spend.
  app.use(cookieParser());
  app.useWebSocketAdapter(new WsAdapter(app));
  app.enableCors({
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      // Private-network origins let a phone on the same Wi-Fi reach a dev
      // stack; a production deployment accepts only WEB_ORIGIN.
      if (
        !origin ||
        origin === env.WEB_ORIGIN ||
        (env.NODE_ENV !== 'production' && /^https?:\/\/(localhost|127\.0\.0\.1|[\w-]+\.local|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+)(:\d+)?$/.test(
          origin,
        ))
      ) {
        callback(null, true);
      } else {
        callback(null, false);
      }
    },
    credentials: true,
  });
  // Schema failures are 400s, not crashes — see the filter.
  app.useGlobalFilters(new ZodExceptionFilter());
  app.enableShutdownHooks();

  await app.listen(env.PORT);

  /**
   * Logs active database name without credentials so accidental test configuration
   * is visible at startup.
   */
  const dbName = (() => {
    try {
      return new URL(env.DATABASE_URL).pathname.replace(/^\//, '') || 'unknown';
    } catch {
      return 'unparseable';
    }
  })();
  const log = new Logger('bootstrap');
  log.log(`Orvia API on http://localhost:${env.PORT}  (ws: /ws/interview)`);
  log.log(`database: ${dbName}   recordings: ${env.DATA_DIR}`);
  if (isTestDatabaseName(dbName)) {
    log.warn(
      `RUNNING AGAINST TEST DATABASE "${dbName}" — the test suites write their ` +
        `rounds and recordings here. Interviews saved here are mixed in with test data.`,
    );
  }
}

void bootstrap();
