/**
 * /server/thronet-server/server.ts
 * Main Entry Point — HTTP server bootstrap
 * Version 4.0.2 (DEBUG — added raw console.log tracers to find MongoDB connect hang;
 * logger.info() is filtered out in production by the logger config, so logger.info
 * calls give no visibility — these console.log lines bypass that filter)
 */
// Add right after the dns/dotenv block, before other imports execute
if (process.env['NODE_ENV'] === 'production') {
  // TEMP: disabled for debugging — re-enable after MongoDB issue fixed
  // console.log = () => {};
  // console.debug = () => {};
}
import dns from 'dns';
import dotenv from 'dotenv';
import path from 'path';

// Fix for Node on Windows DNS resolving MongoDB Atlas SRV records.
// ⚠️ ONLY apply this in local/dev — on Railway (or any Linux container
// production environment) this can break SRV DNS resolution entirely.
// Removed dns.setServers because it breaks local Windows DNS resolution on restricted networks.

// ============================================================
// ENVIRONMENT
// ============================================================

if (process.env['NODE_ENV'] !== 'production') {
  dotenv.config({
    path: path.join(__dirname, '../../.env'),
  });
}

console.log('🟢 TRACE: env block done, NODE_ENV =', process.env['NODE_ENV']);

// ============================================================
// IMPORTS
// ============================================================

import { Server } from 'http';
import mongoose from 'mongoose';

console.log('🟢 TRACE: about to import ./src/app (this triggers the full route-loading chain)');

// App
import { app, NotificationService } from './src/app';

console.log('🟢 TRACE: ./src/app import finished');

// Database
import MongoConnection from './src/database/sharding/connection';

console.log('🟢 TRACE: MongoConnection import finished');

// Utils
import CacheUtil from './src/shared/cache.util';
import { LoggerUtil } from './src/shared/logger.util';

// Socket
import { initializeSocketIO } from './src/socket';

console.log('🟢 TRACE: all imports finished, defining logger/types now');

// ============================================================
// LOGGER
// ============================================================

const logger = LoggerUtil;

// ============================================================
// TYPES
// ============================================================

interface AppLocals {
  server?: Server;
}

// ============================================================
// APPLICATION INITIALIZATION
// ============================================================

async function initializeApp(): Promise<void> {
  console.log('🟢 TRACE: initializeApp() function ENTERED');

  try {
    // ========================================================
    // STEP 1 — APPLICATION START
    // ========================================================

    logger.info('========================================');
    logger.info('Starting application initialization');
    logger.info('========================================');

    console.log('🟢 TRACE: env info log', {
      nodeEnv: process.env['NODE_ENV'],
      nodeVersion: process.version,
      port: process.env['PORT'] || '4000',
    });

    logger.info('Environment information', {
      nodeEnv: process.env['NODE_ENV'],
      nodeVersion: process.version,
      port: process.env['PORT'] || '4000',
    });

    // ========================================================
    // STEP 2 — MONGODB
    // ========================================================

    console.log('🟢 TRACE: >>> ABOUT TO CALL MongoConnection.connect() <<<');
    logger.info('STEP 1: Starting MongoDB connection...');

    await MongoConnection.connect();

    console.log('🟢 TRACE: <<< MongoConnection.connect() RESOLVED SUCCESSFULLY >>>');
    logger.info('MongoDB connected');

    // ========================================================
    // STEP 3 — REDIS / CACHE
    // ========================================================

    console.log('🟢 TRACE: about to init Redis/Cache');
    logger.info('STEP 2: Starting Redis initialization...');

    try {
      logger.info('CACHE INIT START');

      const cacheResult = await CacheUtil.init();

      console.log('🟢 TRACE: CacheUtil.init() resolved', { cacheResult });

      logger.info('CACHE INIT FINISHED', {
        result: cacheResult,
        status: CacheUtil.status,
      });

      if (cacheResult) {
        logger.info('Redis cache initialized successfully');
      } else {
        logger.warn(
          'Redis cache initialization returned false. Using in-memory fallback.'
        );
      }

      logger.info('Cache initialized');
    } catch (err: any) {
      console.log('🔴 TRACE: Cache init threw', err?.message);
      logger.error('CACHE INIT ERROR', {
        error: err?.message || 'Unknown Redis error',
        stack: err?.stack,
      });

      logger.warn(
        'Cache initialization failed, continuing with in-memory fallback'
      );
    }

    // ========================================================
    // STEP 4 — MUTUAL CONNECTIONS SERVICE
    // ========================================================

    console.log('🟢 TRACE: about to init Mutual Connections Service');
    logger.info('STEP 3: Starting Mutual Connections Service...');

    try {
      const { mutualService } = await import(
        './src/connections/services/mutual.service'
      );

      logger.info('Mutual service module loaded');

      await mutualService.initialize();

      console.log('🟢 TRACE: mutualService.initialize() resolved');
      logger.info('Mutual connections service initialized');
    } catch (err: any) {
      console.log('🔴 TRACE: Mutual service init threw', err?.message);
      logger.warn(
        'Mutual service initialization failed, using mock mode',
        {
          error: err?.message || 'Unknown mutual service error',
          stack: err?.stack,
        }
      );
    }

    // ========================================================
    // STEP 5 — NOTIFICATION SERVICE
    // ========================================================

    console.log('🟢 TRACE: about to init Notification Service');
    logger.info('STEP 4: Starting Notification Service...');

    try {
      logger.info('Notification service initialization START');

      const notificationInitialized =
        await NotificationService.initialize();

      console.log('🟢 TRACE: NotificationService.initialize() resolved', {
        notificationInitialized,
      });

      logger.info('Notification service initialization FINISHED', {
        initialized: notificationInitialized,
      });

      if (notificationInitialized) {
        logger.info('Notification service initialized');
      } else {
        logger.warn(
          'Notification service initialization failed (non-critical)'
        );
      }
    } catch (error: any) {
      console.log('🔴 TRACE: Notification service init threw', error?.message);
      logger.warn(
        'Notification service initialization failed (non-critical)',
        {
          error:
            error instanceof Error
              ? error.message
              : 'Unknown notification error',

          stack:
            error instanceof Error
              ? error.stack
              : undefined,
        }
      );
    }

    // ========================================================
    // STEP 6 — HTTP SERVER
    // ========================================================

    console.log('🟢 TRACE: >>> ABOUT TO CALL app.listen() <<<');
    logger.info('STEP 5: Starting HTTP server...');

    const port: number = Number(process.env['PORT']) || 4000;

    console.log('🟢 TRACE: resolved port =', port);

    const server = app.listen(port, () => {
      console.log('🟢 TRACE: <<< app.listen() CALLBACK FIRED — SERVER IS LISTENING on port', port, '>>>');

      logger.info('========================================');
      logger.info('Server started successfully');
      logger.info('========================================');

      logger.info('Server information', {
        port,
        environment: process.env['NODE_ENV'],
        version: process.env['APP_VERSION'] || '1.0.0',
      });

      // ====================================================
      // SOCKET.IO
      // ====================================================

      try {
        console.log('🟢 TRACE: about to init Socket.IO');
        logger.info('Starting Socket.IO initialization...');

        initializeSocketIO(server);

        console.log('🟢 TRACE: Socket.IO initialized');
        logger.info('Socket.IO initialized');
      } catch (error: any) {
        console.log('🔴 TRACE: Socket.IO init threw', error?.message);
        logger.error('Socket.IO initialization failed', {
          error:
            error instanceof Error
              ? error.message
              : 'Unknown Socket.IO error',

          stack:
            error instanceof Error
              ? error.stack
              : undefined,
        });
      }
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      console.log('🔴 TRACE: server.listen() emitted an "error" event', err?.code, err?.message);
    });

    // ========================================================
    // SAVE SERVER INSTANCE
    // ========================================================

    (app.locals as AppLocals).server = server;

    console.log('🟢 TRACE: initializeApp() reached the end (past app.listen() call, not necessarily past the callback)');
    logger.info('Application initialization complete');

    logger.info('========================================');
    logger.info('APPLICATION READY');
    logger.info('========================================');
  } catch (error: any) {
    console.log('🔴 TRACE: initializeApp() CAUGHT A TOP-LEVEL ERROR:', error?.message);
    console.log('🔴 TRACE: stack:', error?.stack);

    logger.error('Application initialization failed', {
      error:
        error instanceof Error
          ? error.message
          : 'Unknown initialization error',

      stack:
        error instanceof Error
          ? error.stack
          : undefined,
    });

    process.exit(1);
  }
}

// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================

async function gracefulShutdown(signal: string): Promise<void> {
  console.log(`🟡 TRACE: gracefulShutdown(${signal}) called`);
  logger.info(`${signal} received, starting graceful shutdown...`);

  try {
    const locals = app.locals as AppLocals;

    if (locals.server) {
      logger.info('Closing HTTP server...');

      await new Promise<void>((resolve) => {
        locals.server!.close(() => {
          resolve();
        });
      });

      logger.info('HTTP server closed');
    }

    try {
      logger.info('Closing MongoDB connection...');

      await mongoose.connection.close();

      logger.info('MongoDB disconnected');
    } catch (error: any) {
      logger.warn('MongoDB shutdown failed', {
        error: error?.message,
      });
    }

    try {
      logger.info('Closing Redis connection...');

      await CacheUtil.shutdown();

      logger.info('Cache shutdown complete');
    } catch (err: any) {
      logger.warn('Cache shutdown failed', {
        error: err?.message,
      });
    }

    logger.info('Graceful shutdown complete');

    process.exit(0);
  } catch (error: any) {
    console.log('🔴 TRACE: gracefulShutdown threw', error?.message);
    logger.error('Error during graceful shutdown', {
      error:
        error instanceof Error
          ? error.message
          : 'Unknown shutdown error',

      stack:
        error instanceof Error
          ? error.stack
          : undefined,
    });

    process.exit(1);
  }
}

// ============================================================
// PROCESS SIGNAL HANDLERS
// ============================================================

process.on('SIGTERM', () => {
  console.log('🟡 TRACE: SIGTERM received');
  gracefulShutdown('SIGTERM');
});

process.on('SIGINT', () => {
  console.log('🟡 TRACE: SIGINT received');
  gracefulShutdown('SIGINT');
});

// ============================================================
// UNHANDLED PROMISE REJECTION
// ============================================================

process.on('unhandledRejection', (reason: unknown) => {
  const errorMessage =
    (reason as any)?.message ||
    String(reason);

  const errorStack =
    (reason as any)?.stack;

  console.log('🔴 TRACE: unhandledRejection:', errorMessage);

  if (errorMessage.includes('schemas/ids')) {
    logger.warn(
      'Schema validation error ignored (OpenTelemetry)'
    );
    return;
  }

  logger.error('Unhandled promise rejection', {
    reason: errorMessage,
    stack: errorStack,
  });
});

// ============================================================
// UNCAUGHT EXCEPTION
// ============================================================

process.on('uncaughtException', (error: Error) => {
  console.log('🔴 TRACE: uncaughtException:', error.message);
  console.log('🔴 TRACE: uncaughtException stack:', error.stack);

  logger.error('Uncaught exception in server file', {
    error: error.message,
    stack: error.stack,
  });

  const criticalErrors = [
    'EADDRINUSE',
    'MODULE_NOT_FOUND',
  ];

  const isCritical = criticalErrors.some((criticalError) =>
    error.message.includes(criticalError)
  );

  if (isCritical) {
    gracefulShutdown('UNCAUGHT_EXCEPTION');
  }
});

// ============================================================
// START APPLICATION
// ============================================================

console.log('🟢 TRACE: BOOTSTRAP line reached, calling initializeApp() now');
logger.info('BOOTSTRAP: Calling initializeApp()');

initializeApp();

console.log('🟢 TRACE: initializeApp() call dispatched (this line runs immediately since initializeApp is async — it does NOT mean initializeApp finished)');