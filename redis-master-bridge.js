const os = require('node:os');

/**
 * Fans out master control-plane events/commands across ws-multiplexer
 * instances via Redis, so an operator connected to the master port of any
 * instance sees monitoring traffic and can inject messages for a connection
 * hosted on a different instance.
 *
 * Never touches the client<->upstream data-plane: if Redis is unavailable or
 * `redisUrl` is not provided, every method becomes a harmless no-op and the
 * master control-plane simply falls back to per-instance visibility.
 *
 * @param {{
 *   redisUrl: string,
 *   keyPrefix?: string,
 *   instanceId?: string,
 *   registryTtlSeconds?: number,
 *   registryRefreshIntervalMs?: number,
 *   logger?: { warn: Function },
 * }} options
 */
function createRedisMasterBridge({
  redisUrl,
  keyPrefix = 'ws-multiplex:',
  instanceId = os.hostname(),
  registryTtlSeconds = 60,
  registryRefreshIntervalMs = 20000,
  logger = console,
}) {
  if (!redisUrl) {
    return createNoopBridge();
  }

  const Redis = require('ioredis').default;
  const retryStrategy = (times) => Math.min(times * 200, 5000);

  // A subscribed connection can only issue pub/sub commands, so registry
  // reads/writes and publishes use a separate connection from the one
  // listening for events/commands. The command client fails fast instead of
  // queueing (no backlog of stale registry writes/publishes during a Redis
  // outage); the subscriber keeps the default offline queue so its startup
  // SUBSCRIBE isn't lost while the connection is still being established,
  // and so ioredis can resubscribe it automatically after a reconnect.
  const commandClient = new Redis(redisUrl, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy,
  });
  const subscriberClient = new Redis(redisUrl, { retryStrategy });

  commandClient.on('error', (error) => {
    logger.warn('[redis] command connection error:', error.message);
  });
  subscriberClient.on('error', (error) => {
    logger.warn('[redis] subscriber connection error:', error.message);
  });

  const eventsChannel = `${keyPrefix}events`;
  const commandsChannel = `${keyPrefix}commands`;
  const registryKeyPrefix = `${keyPrefix}registry:`;
  const registryRefreshTimers = new Map();

  /** @type {(envelope: any) => void} */
  let remoteEventHandler = () => {};
  /** @type {(data: any) => void} */
  let remoteCommandHandler = () => {};

  subscriberClient
    .subscribe(eventsChannel, commandsChannel)
    .catch((error) => {
      logger.warn('[redis] failed to subscribe:', error.message);
    });

  subscriberClient.on('message', (channel, raw) => {
    let envelope;
    try {
      envelope = JSON.parse(raw);
    } catch (error) {
      logger.warn('[redis] failed to parse message:', error.message);
      return;
    }

    // Already delivered locally at the point this instance published it.
    if (envelope.instanceId === instanceId) return;

    if (channel === eventsChannel) {
      remoteEventHandler(envelope);
    } else if (channel === commandsChannel) {
      remoteCommandHandler(envelope.data);
    }
  });

  function registryKey(pathname) {
    return `${registryKeyPrefix}${pathname}`;
  }

  function registerConnection(pathname) {
    const refresh = () => {
      commandClient
        .set(registryKey(pathname), instanceId, 'EX', registryTtlSeconds)
        .catch((error) => {
          logger.warn(
            `[redis] failed to register ${pathname}:`,
            error.message
          );
        });
    };

    refresh();
    const timer = setInterval(refresh, registryRefreshIntervalMs);
    timer.unref?.();
    registryRefreshTimers.set(pathname, timer);
  }

  function unregisterConnection(pathname) {
    const timer = registryRefreshTimers.get(pathname);
    if (timer) {
      clearInterval(timer);
      registryRefreshTimers.delete(pathname);
    }

    commandClient.del(registryKey(pathname)).catch((error) => {
      logger.warn(
        `[redis] failed to unregister ${pathname}:`,
        error.message
      );
    });
  }

  async function listRegisteredPaths() {
    const paths = [];
    try {
      let cursor = '0';
      do {
        const [nextCursor, keys] = await commandClient.scan(
          cursor,
          'MATCH',
          `${registryKeyPrefix}*`,
          'COUNT',
          100
        );
        cursor = nextCursor;
        for (const key of keys) {
          paths.push(key.slice(registryKeyPrefix.length));
        }
      } while (cursor !== '0');
    } catch (error) {
      logger.warn('[redis] failed to list registered paths:', error.message);
      return [];
    }
    return paths;
  }

  function publish(channel, envelope) {
    commandClient
      .publish(channel, JSON.stringify({ ...envelope, instanceId }))
      .catch((error) => {
        logger.warn(`[redis] failed to publish to ${channel}:`, error.message);
      });
  }

  function publishEvent(envelope) {
    publish(eventsChannel, envelope);
  }

  function publishCommand(data) {
    publish(commandsChannel, { data });
  }

  async function close() {
    for (const timer of registryRefreshTimers.values()) {
      clearInterval(timer);
    }
    registryRefreshTimers.clear();
    await Promise.allSettled([commandClient.quit(), subscriberClient.quit()]);
  }

  return {
    isAvailable: () => true,
    registerConnection,
    unregisterConnection,
    listRegisteredPaths,
    publishEvent,
    publishCommand,
    onRemoteEvent: (handler) => {
      remoteEventHandler = handler;
    },
    onRemoteCommand: (handler) => {
      remoteCommandHandler = handler;
    },
    close,
  };
}

function createNoopBridge() {
  return {
    isAvailable: () => false,
    registerConnection: () => {},
    unregisterConnection: () => {},
    listRegisteredPaths: async () => [],
    publishEvent: () => {},
    publishCommand: () => {},
    onRemoteEvent: () => {},
    onRemoteCommand: () => {},
    close: async () => {},
  };
}

module.exports = { createRedisMasterBridge };
