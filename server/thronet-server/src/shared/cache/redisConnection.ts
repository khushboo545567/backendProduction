/**
 * Unified Redis Connection Factory
 * Provides a single, production-grade ioredis connection lifecycle with cluster/standalone support,
 * connection pooling for dedicated tasks (PubSub/BullMQ), retry backoff, health checks, and graceful shutdown.
 */

import Redis, { Cluster, RedisOptions, ClusterOptions } from 'ioredis';
import { LoggerUtil } from '@/shared/logger.util';

export interface RedisConnectionHealth {
  status: 'healthy' | 'degraded' | 'down';
  latencyMs: number;
  isCluster: boolean;
  totalConnections: number;
  message?: string;
}

export interface DedicatedClientOptions {
  name?: string;
  maxRetriesPerRequest?: number | null;
  enableOfflineQueue?: boolean;
}

// ==================== STATE ====================
let mainClient: Redis | Cluster | null = null;
const dedicatedClients = new Set<Redis | Cluster>();
let isShuttingDown = false;

// ==================== CONFIGURATION ====================
export const getRedisConfig = () => {
  const isCluster = process.env['REDIS_CLUSTER_MODE'] === 'true';
  const rawHost = process.env['REDIS_HOST'];
  const host = rawHost && !rawHost.includes('${') ? rawHost : '127.0.0.1';
  const rawPort = process.env['REDIS_PORT'];
  const parsedPort = rawPort ? parseInt(rawPort, 10) : 6379;
  const port = !isNaN(parsedPort) && parsedPort > 0 && parsedPort < 65536 ? parsedPort : 6379;
  const rawPassword = process.env['REDIS_PASSWORD'];
  const password = rawPassword && !rawPassword.includes('${') ? rawPassword : undefined;
  const rawDb = process.env['REDIS_DB'];
  const parsedDb = rawDb ? parseInt(rawDb, 10) : 0;
  const db = !isNaN(parsedDb) && parsedDb >= 0 ? parsedDb : 0;
  const rawClusterNodes = process.env['REDIS_CLUSTER_NODES'] || '';

  const clusterNodes = rawClusterNodes
    ? rawClusterNodes.split(',').map((nodeStr) => {
        const [nodeHost, nodePort] = nodeStr.trim().split(':');
        const parsedNodePort = nodePort ? parseInt(nodePort, 10) : 6379;
        return {
          host: nodeHost && !nodeHost.includes('${') ? nodeHost : '127.0.0.1',
          port: !isNaN(parsedNodePort) && parsedNodePort > 0 ? parsedNodePort : 6379,
        };
      })
    : [{ host, port }];

  return {
    isCluster,
    host,
    port,
    password,
    db,
    clusterNodes,
    commandTimeoutMs: parseInt(process.env['REDIS_COMMAND_TIMEOUT_MS'] || '2000', 10) || 2000,
    connectTimeoutMs: parseInt(process.env['REDIS_CONNECT_TIMEOUT_MS'] || '10000', 10) || 10000,
  };
};

/**
 * Standard retry strategy with exponential backoff and jitter
 */
const defaultRetryStrategy = (times: number): number | void => {
  if (isShuttingDown) return undefined;
  const delay = Math.min(times * 100, 3000);
  const jitter = Math.floor(Math.random() * 200);
  LoggerUtil.warn(`Redis connection retry attempt ${times}, waiting ${delay + jitter}ms`);
  return delay + jitter;
};

/**
 * Create a standalone or cluster ioredis instance
 */
function createInstance(options: {
  maxRetriesPerRequest?: number | null;
  enableOfflineQueue?: boolean;
  name?: string;
}): Redis | Cluster {
  const config = getRedisConfig();
  const clientName = options.name || 'main';

  const redisOptions: RedisOptions = {
    host: config.host,
    port: config.port,
    password: config.password,
    db: config.db,
    connectTimeout: config.connectTimeoutMs,
    commandTimeout: config.commandTimeoutMs,
    maxRetriesPerRequest: options.maxRetriesPerRequest !== undefined ? options.maxRetriesPerRequest : 3,
    enableOfflineQueue: options.enableOfflineQueue !== undefined ? options.enableOfflineQueue : true,
    enableReadyCheck: true,
    lazyConnect: true,
    retryStrategy: defaultRetryStrategy,
    reconnectOnError: (err: Error) => {
      const targetError = 'READONLY';
      if (err.message && err.message.includes(targetError)) {
        return true;
      }
      return false;
    },
  };

  let client: Redis | Cluster;

  if (config.isCluster) {
    const clusterOptions: ClusterOptions = {
      clusterRetryStrategy: (times) => defaultRetryStrategy(times) ?? 2000,
      enableReadyCheck: true,
      scaleReads: 'slave',
      redisOptions: {
        password: config.password,
        connectTimeout: config.connectTimeoutMs,
        commandTimeout: config.commandTimeoutMs,
      },
    };
    client = new Redis.Cluster(config.clusterNodes, clusterOptions);
  } else {
    client = new Redis(redisOptions);
  }

  // Attach structured event listeners
  client.on('connect', () => {
    LoggerUtil.info(`[Redis:${clientName}] Socket connected to Redis`);
  });

  client.on('ready', () => {
    LoggerUtil.info(`[Redis:${clientName}] Ready to accept commands`);
  });

  client.on('error', (err: Error) => {
    LoggerUtil.error(`[Redis:${clientName}] Connection error`, {
      message: err.message,
      name: err.name,
    });
  });

  client.on('close', () => {
    if (!isShuttingDown) {
      LoggerUtil.warn(`[Redis:${clientName}] Connection closed`);
    }
  });

  client.on('reconnecting', (time: number) => {
    LoggerUtil.warn(`[Redis:${clientName}] Reconnecting in ${time}ms`);
  });

  return client;
}

/**
 * Get or lazily create the main shared Redis client
 */
export const getRedisClient = (): Redis | Cluster => {
  if (!mainClient) {
    mainClient = createInstance({ name: 'main', maxRetriesPerRequest: 3 });
  }
  return mainClient;
};

/**
 * Create a dedicated Redis client for separate workloads (PubSub, BullMQ, blocking queues)
 */
export const createDedicatedClient = (options: DedicatedClientOptions = {}): Redis | Cluster => {
  const client = createInstance({
    name: options.name || 'dedicated',
    maxRetriesPerRequest: options.maxRetriesPerRequest !== undefined ? options.maxRetriesPerRequest : null,
    enableOfflineQueue: options.enableOfflineQueue !== undefined ? options.enableOfflineQueue : true,
  });
  dedicatedClients.add(client);

  client.on('end', () => {
    dedicatedClients.delete(client);
  });

  return client;
};

/**
 * Initialize and verify main Redis connection
 */
export const initRedis = async (): Promise<boolean> => {
  try {
    const client = getRedisClient();
    if (client.status === 'ready') {
      return true;
    }

    if (client.status === 'wait' || client.status === 'close') {
      await client.connect();
    }

    const pong = await client.ping();
    LoggerUtil.info('Redis initialized successfully', { ping: pong });
    return true;
  } catch (error: any) {
    LoggerUtil.error('Failed to initialize Redis connection', {
      error: error.message,
      stack: error.stack,
    });
    return false;
  }
};

/**
 * Health check with round-trip latency probe
 */
export const getRedisHealth = async (): Promise<RedisConnectionHealth> => {
  const client = getRedisClient();
  const config = getRedisConfig();
  const startTime = Date.now();

  try {
    const pong = await client.ping();
    const latencyMs = Date.now() - startTime;

    if (pong === 'PONG') {
      return {
        status: latencyMs > 500 ? 'degraded' : 'healthy',
        latencyMs,
        isCluster: config.isCluster,
        totalConnections: 1 + dedicatedClients.size,
      };
    }

    return {
      status: 'degraded',
      latencyMs,
      isCluster: config.isCluster,
      totalConnections: 1 + dedicatedClients.size,
      message: `Unexpected ping response: ${pong}`,
    };
  } catch (error: any) {
    return {
      status: 'down',
      latencyMs: Date.now() - startTime,
      isCluster: config.isCluster,
      totalConnections: 1 + dedicatedClients.size,
      message: error.message,
    };
  }
};

/**
 * Gracefully close all Redis connections
 */
export const closeRedis = async (): Promise<void> => {
  isShuttingDown = true;
  LoggerUtil.info('Closing all Redis connections...');

  const closePromises: Promise<any>[] = [];

  if (mainClient) {
    closePromises.push(
      mainClient.quit().catch(() => mainClient?.disconnect())
    );
    mainClient = null;
  }

  for (const client of dedicatedClients) {
    closePromises.push(
      client.quit().catch(() => client.disconnect())
    );
  }
  dedicatedClients.clear();

  await Promise.allSettled(closePromises);
  LoggerUtil.info('All Redis connections closed');
};

export const closeRedisConnection = closeRedis;
