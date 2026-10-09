const WebSocket = require('ws');
const crypto = require('node:crypto');
const http = require('node:http');
const url = require('node:url');
const util = require('node:util');

// Configuration
const PORT = process.env.PORT || 8080;
const MASTER_PORT = process.env.MASTER_PORT || 8081;
const UPSTREAM_URL = process.env.UPSTREAM_URL || 'ws://localhost:9000';
const DYNAMIC_UPSTREAM_CONFIG_URL = process.env.DYNAMIC_UPSTREAM_CONFIG_URL;
const LOG_LEVEL = process.env.LOG_LEVEL || 'INFO';
const DYNAMIC_UPSTREAM_MAX_ATTEMPTS =
  Number(process.env.DYNAMIC_UPSTREAM_MAX_ATTEMPTS) || 4;
const DYNAMIC_UPSTREAM_RETRY_DELAY_MS =
  Number(process.env.DYNAMIC_UPSTREAM_RETRY_DELAY_MS) || 30000; // 30 seconds default
const MESSAGE_QUEUE_TIMEOUT =
  Number(process.env.MESSAGE_QUEUE_TIMEOUT) || 30000; // 30 seconds default
const STATION_HEARTBEAT_INTERVAL_MS = readIntervalMs(
  process.env.STATION_HEARTBEAT_INTERVAL_MS,
  30000
);

/**
 * Reads a non-negative millisecond setting where 0 is meaningful (`Number(x) || fallback` would drop it)
 * @param {string | undefined} value - The raw environment value
 * @param {number} fallback - The value used when unset or invalid
 * @returns {number} The interval in milliseconds
 */
function readIntervalMs(value, fallback) {
  if (value === undefined || value.trim() === '') return fallback;
  const ms = Number(value);
  return Number.isFinite(ms) && ms >= 0 ? ms : fallback;
}

// Logging levels
const LOG_LEVELS = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3,
};

// Current log level
const CURRENT_LOG_LEVEL =
  LOG_LEVELS[LOG_LEVEL] !== undefined ? LOG_LEVELS[LOG_LEVEL] : LOG_LEVELS.INFO;

// Last line of defence: stdout ends up in Loki and the S3 export, so no line may carry a station credential.
const AUTH_VALUE_PATTERN = /\b(Basic|Bearer)\s+[A-Za-z0-9+/._~-]{8,}=*/gi;
// OCPP 1.6 ChangeConfiguration(AuthorizationKey) and 2.0.1 SetVariables(BasicAuthPassword) carry the password itself.
const CREDENTIAL_FRAME_PATTERN = /AuthorizationKey|BasicAuthPassword/i;

/**
 * Masks credentials in a formatted log line
 * @param {string} line - The formatted log line
 * @returns {string} The line, safe to write to stdout
 */
function redactLogLine(line) {
  if (CREDENTIAL_FRAME_PATTERN.test(line)) {
    return '<redacted: line may carry a station password>';
  }
  return line.replace(AUTH_VALUE_PATTERN, '$1 <redacted>');
}

/**
 * Formats, redacts and writes a log line
 * @param {(line: string) => void} write - The console method to write with
 * @param {string} level - The level label
 * @param {string} message - The message, used as a format string like console.log does
 * @param {any[]} args - The format arguments
 */
function writeLog(write, level, message, args) {
  write(`[${level}] ${redactLogLine(util.format(message, ...args))}`);
}

/**
 * Logger utility for consistent logging with level control
 */
const logger = {
  error: (message, ...args) => {
    if (CURRENT_LOG_LEVEL >= LOG_LEVELS.ERROR) {
      writeLog(console.error, 'ERROR', message, args);
    }
  },
  warn: (message, ...args) => {
    if (CURRENT_LOG_LEVEL >= LOG_LEVELS.WARN) {
      writeLog(console.warn, 'WARN', message, args);
    }
  },
  info: (message, ...args) => {
    if (CURRENT_LOG_LEVEL >= LOG_LEVELS.INFO) {
      writeLog(console.log, 'INFO', message, args);
    }
  },
  debug: (message, ...args) => {
    if (CURRENT_LOG_LEVEL >= LOG_LEVELS.DEBUG) {
      writeLog(console.log, 'DEBUG', message, args);
    }
  },
};

const CREDENTIAL_HEADERS = new Set(['authorization', 'proxy-authorization']);

/**
 * Masks a credential header value, keeping the scheme so readers still see which auth was used
 * @param {string | string[]} value - The header value
 * @returns {string} The masked value
 */
function redactCredential(value) {
  const scheme = /^\s*(Basic|Bearer)\s/i.exec(String(value));
  return scheme ? `${scheme[1]} <redacted>` : '<redacted>';
}

/**
 * Returns a copy of request headers safe to log or to hand to master listeners
 * @param {http.IncomingHttpHeaders} headers - The original headers
 * @returns {http.IncomingHttpHeaders} The headers with credentials masked
 */
function redactHeaders(headers) {
  /** @type {http.IncomingHttpHeaders} */
  const redacted = {};
  for (const [name, value] of Object.entries(headers || {})) {
    redacted[name] = CREDENTIAL_HEADERS.has(name.toLowerCase())
      ? redactCredential(value)
      : value;
  }
  return redacted;
}

/**
 * Digests the Authorization header: enough to recognise a station reconnecting with its accepted credentials
 * @param {string | undefined} authorization - The Authorization header value
 * @returns {Buffer | null} The SHA-256 digest, or null without a credential
 */
function digestCredential(authorization) {
  // Two anonymous handshakes would otherwise share the digest of the empty string and pass for the same station.
  if (!authorization) return null;
  return crypto.createHash('sha256').update(String(authorization)).digest();
}

/**
 * Tells whether a handshake carries the exact credential the connected station was accepted with
 * @param {Buffer | null} connected - The credential digest of the connected station
 * @param {Buffer | null} incoming - The credential digest of the new handshake
 * @returns {boolean} True only when both sides carry the same non-empty credential
 */
function isSameCredential(connected, incoming) {
  if (!connected || !incoming) return false;
  return crypto.timingSafeEqual(connected, incoming);
}

// Create HTTP servers
const server = http.createServer();
const masterServer = http.createServer();

// WebSocket server options with logging
const wsOptions = {
  server,
  perMessageDeflate: true,
  // Hold each station handshake until its upstream answers, so a refusal reaches the station as an HTTP status.
  verifyClient: (info, done) => {
    holdClientHandshake(info.req, done);
  },
  handleProtocols: selectClientProtocol,
};

const masterWsOptions = {
  server: masterServer,
  perMessageDeflate: true,
};

/**
 * Resolves the upstream URL for a given pathname using dynamic configuration if available
 * @param {string} pathname - The connection path
 * @returns {Promise<URL>} The resolved upstream URL
 */
async function resolveUpstreamUrl(pathname) {
  const defaultUrl = new URL(UPSTREAM_URL + pathname);
  if (!DYNAMIC_UPSTREAM_CONFIG_URL) {
    return defaultUrl;
  }

  const configUrl = DYNAMIC_UPSTREAM_CONFIG_URL + pathname;
  const maxAttempts = DYNAMIC_UPSTREAM_MAX_ATTEMPTS;
  const retryDelayMs = DYNAMIC_UPSTREAM_RETRY_DELAY_MS;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      logger.debug(
        `Requesting dynamic upstream config from: ${configUrl} (attempt ${attempt}/${maxAttempts})`
      );

      const response = await fetch(configUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(5000), // 5 second timeout
      });

      if (!response.ok)
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);

      const upstreamUrlString = (await response.text()).trim();

      // Validate that the response is a valid URL
      let upstreamUrl;
      try {
        upstreamUrl = new URL(upstreamUrlString);
      } catch (urlError) {
        throw new Error(
          `Invalid URL returned from ${configUrl}: ${upstreamUrlString}. ${urlError}`
        );
      }

      // Validate that it's a WebSocket URL
      if (upstreamUrl.protocol !== 'ws:' && upstreamUrl.protocol !== 'wss:') {
        throw new Error(
          `Invalid WebSocket URL protocol: ${upstreamUrl.protocol}. Expected ws: or wss:`
        );
      }

      logger.info(
        `Dynamic upstream resolved for ${pathname}: ${upstreamUrl.href}`
      );
      return upstreamUrl;
    } catch (error) {
      const isLastAttempt = attempt === maxAttempts;
      logger.warn(
        `Dynamic upstream resolution failed for ${pathname} on attempt ${attempt}/${maxAttempts}: ${error.message}${
          isLastAttempt
            ? `. Using default: ${defaultUrl.href}`
            : `. Retrying in ${retryDelayMs / 1000}s`
        }`
      );

      if (isLastAttempt) {
        return defaultUrl;
      }

      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }

  // Fallback safeguard (should not be reached)
  return defaultUrl;
}

/**
 * Global connection store for tracking all active connections
 * @typedef {{ ws: WebSocket, connected: boolean, upstreamId: string, upstreamUrl: URL, generation: number, credentialDigest: Buffer | null, alive: boolean }} ClientConnection
 * @typedef {{ ws: WebSocket, connected: boolean, clientId: string, upstreamUrl: URL }} UpstreamConnection
 * @typedef {{ ws: WebSocket, path: string, type: 'root' | 'client' | 'upstream', targetPath: string }} MasterConnection
 * @typedef {{ message: string | Buffer, timestamp: string }} QueuedMessage
 * @typedef {{
 *   clients: Map<string, ClientConnection>,
 *   upstreams: Map<string, UpstreamConnection>,
 *   masters: Set<MasterConnection>,
 *   messageQueues: Map<string, QueuedMessage[]>
 * }} Connections
 *
 * @type {Connections}
 */
const connections = {
  clients: new Map(),
  upstreams: new Map(),
  masters: new Set(),
  messageQueues: new Map(),
};

/**
 * A station handshake held open until its upstream answers
 * @typedef {{
 *   req: http.IncomingMessage,
 *   done: (verified: boolean, code?: number) => void,
 *   pathname: string,
 *   ip: string,
 *   generation: number,
 *   credentialDigest: Buffer | null,
 *   state: 'pending' | 'accepted' | 'rejected',
 *   upstreamWs: WebSocket | null,
 *   upstreamUrl: URL | null,
 *   releaseSocket: (handBack: boolean) => void,
 * }} PendingClient
 */

// Lets the 'connection' handler and the subprotocol selection find the upstream opened for a handshake.
/** @type {WeakMap<http.IncomingMessage, PendingClient>} */
const pendingClients = new WeakMap();

// Arrival order of handshakes: on a path, an older handshake never replaces a newer accepted connection.
let handshakeCounter = 0;

/** @type {NodeJS.Timeout | null} */
let stationHeartbeat = null;

/**
 * Starts pinging the stations, unless STATION_HEARTBEAT_INTERVAL_MS is 0
 * @returns {NodeJS.Timeout | null} The heartbeat timer, null when disabled
 */
function startStationHeartbeat() {
  if (STATION_HEARTBEAT_INTERVAL_MS === 0) {
    logger.info('Station heartbeat: disabled');
    return null;
  }
  logger.info(`Station heartbeat: every ${STATION_HEARTBEAT_INTERVAL_MS}ms`);
  return setInterval(checkStationsAlive, STATION_HEARTBEAT_INTERVAL_MS);
}

/**
 * Terminates the stations silent since the previous tick and pings the others
 */
function checkStationsAlive() {
  // A half-open station socket (e.g. a 4G IP change) keeps its upstream session, so the CSMS refuses the reconnection as a duplicate, until TCP gives up (~15 min).
  for (const [pathname, client] of connections.clients) {
    if (!client.alive) {
      logger.warn(
        `Station ${pathname} did not answer the heartbeat ping, terminating its connection`
      );
      // Emits 'close', so both legs go through handleClientDisconnection like a normal station close.
      client.ws.terminate();
      continue;
    }
    client.alive = false;
    if (client.ws.readyState === WebSocket.OPEN) client.ws.ping();
  }
}

/**
 * Initializes WebSocket servers and enables internal logging if needed
 * @returns {{ wss: WebSocket.Server, masterWss: WebSocket.Server }} Object containing the WebSocket servers
 */
function initializeWebSocketServers() {
  // Enable WebSocket internal logging if debug level
  if (CURRENT_LOG_LEVEL >= LOG_LEVELS.DEBUG) {
    WebSocket.createWebSocketStream.prototype.on = function (event, listener) {
      logger.debug(`WebSocketStream event: ${event}`);
      return this.on.call(this, event, listener);
    };
  }

  // Create WebSocket servers
  const wss = new WebSocket.Server(wsOptions);
  const masterWss = new WebSocket.Server(masterWsOptions);

  return { wss, masterWss };
}

/**
 * Sets up event listeners for the WebSocket server
 * @param {WebSocket.Server} wss - The WebSocket server
 */
function setupServerEventListeners(wss) {
  wss.on('listening', () => {
    logger.info(`WebSocket server listening on port ${PORT}`);
  });

  wss.on('error', (error) => {
    logger.error('WebSocket server error:', error);
  });
}

/**
 * Sets up event listeners for the master WebSocket server
 * @param {WebSocket.Server} masterWss - The master WebSocket server
 */
function setupMasterServerEventListeners(masterWss) {
  masterWss.on('listening', () => {
    logger.info(`Master WebSocket server listening on port ${MASTER_PORT}`);
  });

  masterWss.on('error', (error) => {
    logger.error('Master WebSocket server error:', error);
  });
}

/**
 * Sends current connection status to the master
 * @param {WebSocket} masterWs - The master WebSocket connection
 */
function sendStatusToMaster(masterWs) {
  const status = {
    type: 'status',
    clients: Array.from(connections.clients.keys()),
    upstreams: Array.from(connections.upstreams.keys()),
  };
  sendMessage(masterWs, JSON.stringify(status), 'multiplexer', 'master');
  logger.debug('Sent status to master:', status);
}

/**
 * Sends a message to a WebSocket connection with logging
 * @param {WebSocket} ws - The WebSocket connection
 * @param {string | Buffer | ArrayBuffer | Buffer[]} message - The message to send
 * @param {string} source - Source identifier (e.g., 'multiplexer')
 * @param {string} target - Target identifier (e.g., 'client:123')
 */
function sendMessage(ws, message, source, target) {
  ws.send(message);

  if (CURRENT_LOG_LEVEL >= LOG_LEVELS.DEBUG) {
    const messageStr = message.toString();
    logger.debug(`${source} -> ${target}: ${messageStr}`);
  }
}

/**
 * Handles message injection from master to specified targets
 * @param {InjectionMessage} data - The message data containing target and message
 */
function handleMasterInjection(data) {
  if (data.target === 'all-clients') {
    logger.info('Master injecting message to all clients');
    for (const client of connections.clients.values()) {
      sendMessage(
        client.ws,
        data.message,
        'multiplexer',
        `client:${client.upstreamId}`
      );
    }
  } else if (data.target === 'all-upstreams') {
    logger.info('Master injecting message to all upstreams');
    for (const upstream of connections.upstreams.values()) {
      sendMessage(
        upstream.ws,
        data.message,
        'multiplexer',
        `upstream:${upstream.clientId}`
      );
    }
  } else if (data.target.startsWith('client:')) {
    const clientId = data.target.substring(7);
    logger.info(`Master injecting message to client: ${clientId}`);
    const client = connections.clients.get(clientId);
    if (client) {
      sendMessage(client.ws, data.message, 'multiplexer', data.target);
    } else {
      logger.warn(`Client ${clientId} not found for message injection`);
    }
  } else if (data.target.startsWith('upstream:')) {
    const upstreamId = data.target.substring(9);
    logger.info(`Master injecting message to upstream: ${upstreamId}`);
    const upstream = connections.upstreams.get(upstreamId);
    if (upstream) {
      sendMessage(upstream.ws, data.message, 'multiplexer', data.target);
    } else {
      logger.warn(`Upstream ${upstreamId} not found for message injection`);
    }
  }
}

/**
 * Handles connection closure requests from master
 * @param {CloseMessage} data - The close data containing connection ID and optional reason
 */
function handleMasterClose(data) {
  const connectionId = data.connectionId;
  const reason = data.reason || 'Closed by websocket-multiplex master control';

  logger.info(`Master requesting to close connection: ${connectionId}`);

  const client = connections.clients.get(connectionId);
  const upstream = connections.upstreams.get(connectionId);

  if (!client && !upstream) {
    logger.warn(`Connection ${connectionId} not found for closure`);
    return;
  }

  // Close client connection if it exists
  if (client && client.ws.readyState === WebSocket.OPEN) {
    logger.info(`Closing client connection for ${connectionId}`);
    client.ws.close(1000, reason);
  }

  // Close upstream connection if it exists
  if (upstream && upstream.ws.readyState === WebSocket.OPEN) {
    logger.info(`Closing upstream connection for ${connectionId}`);
    upstream.ws.close(1000, reason);
  }

  // Clean up message queue
  connections.messageQueues.delete(connectionId);

  // Notify root masters about the forced closure
  notifyRootMasters('connection', 'connection-closed-by-master', connectionId, {
    reason,
    timestamp: new Date().toISOString(),
  });
}

/**
 * @typedef {Object} InjectionMessage
 * @property {'inject'} type - Message type
 * @property {string} target - Target for injection ('all-clients', 'all-upstreams', 'client:...', 'upstream:...')
 * @property {string | Buffer} message - Message to inject
 */

/**
 * @typedef {Object} CloseMessage
 * @property {'close'} type - Message type
 * @property {string} connectionId - Connection ID to close
 * @property {string} [reason] - Optional reason for closure
 */

/**
 * Validates an injection message
 * @param {any} data - Data to validate
 * @returns {data is InjectionMessage} True if valid injection message
 */
function validateInjectionMessage(data) {
  return (
    data &&
    typeof data === 'object' &&
    data.type === 'inject' &&
    typeof data.target === 'string' &&
    data.target.length > 0 &&
    (typeof data.message === 'string' || Buffer.isBuffer(data.message))
  );
}

/**
 * Validates a close message
 * @param {any} data - Data to validate
 * @returns {data is CloseMessage} True if valid close message
 */
function validateCloseMessage(data) {
  return (
    data &&
    typeof data === 'object' &&
    data.type === 'close' &&
    typeof data.connectionId === 'string' &&
    data.connectionId.length > 0
  );
}

/**
 * Handles messages from root master connections
 * @param {string} message - The message received
 * @throws {Error} When message is invalid
 */
function handleRootMasterMessage(message) {
  const data = JSON.parse(message);
  logger.debug(`multiplexer <- master client: root ${JSON.stringify(data)}`);

  if (validateInjectionMessage(data)) return handleMasterInjection(data);
  else if (validateCloseMessage(data)) return handleMasterClose(data);
  else
    throw new Error(
      `Invalid master message: unsupported type '${data?.type}' or missing required fields. Message: ${JSON.stringify(data)}`
    );
}

/**
 * Handles messages from master connection with type = 'client'
 * @param {string} targetPath - The target client path
 * @param {string} message - The message to forward
 */
function handleMasterMessageForClient(targetPath, message) {
  const client = connections.clients.get(targetPath);
  if (client?.connected) {
    sendMessage(client.ws, message, 'master', `client:${targetPath}`);
  }
}

/**
 * Handles messages from master connection with type = 'upstream'
 * @param {string} targetPath - The target upstream path
 * @param {string} message - The message to forward
 */
function handleMasterMessageForUpstream(targetPath, message) {
  const upstream = connections.upstreams.get(targetPath);
  if (upstream?.connected) {
    sendMessage(upstream.ws, message, 'master', `upstream:${targetPath}`);
  }
}

/**
 * Handles messages received from the master connection
 * @param { MasterConnection } masterConnection - The master WebSocket connection
 * @param {string} message - The message received
 */
function handleMasterMessage(masterConnection, message) {
  const { type, targetPath } = masterConnection;

  try {
    switch (type) {
      case 'root':
        return handleRootMasterMessage(message);
      case 'client':
        return handleMasterMessageForClient(targetPath, message);
      case 'upstream':
        return handleMasterMessageForUpstream(targetPath, message);
    }
  } catch (error) {
    logger.error('Error processing master message:', error);
  }
}

/**
 * Sets up a new master control connection
 * @param {WebSocket} ws - The WebSocket connection
 * @param {http.IncomingMessage} req - The HTTP request
 */
function setupMasterConnection(ws, req) {
  const ip = req.socket.remoteAddress;
  const pathname = url.parse(req.url).pathname;

  logger.info(`Master control connected from ${ip} on path ${pathname}`);

  /** @type {'root' | 'client' | 'upstream'} */
  let type = 'root';
  /** @type {string} */
  let targetPath = pathname;

  if (pathname !== '/') {
    const [pathType, ...pathParts] = pathname.slice(1).split('/', 2);
    if (pathType !== 'client' && pathType !== 'upstream') {
      ws.close(
        1008,
        'Invalid master path - must be / or /client/:path or /upstream/:path'
      );
      return;
    }
    type = pathType;
    targetPath = `/${pathParts.join('/')}`;
  }

  const masterConnection = { ws, path: pathname, type, targetPath };
  connections.masters.add(masterConnection);

  if (type === 'root') {
    sendStatusToMaster(ws);
  }

  ws.on('message', (message) =>
    handleMasterMessage(masterConnection, message.toString())
  );

  ws.on('close', (code, reason) => {
    logger.info(
      `Master control disconnected from ${pathname}. Code: ${code}, Reason: ${
        reason || 'No reason provided'
      }`
    );
    connections.masters.delete(masterConnection);
  });

  ws.on('error', (error) => {
    logger.error('Master connection error:', error);
  });
}

/**
 * Queues a message for later delivery
 * @param {string} pathname - The connection identifier
 * @param {string | Buffer} message - The message to queue
 */
function queueMessage(pathname, message) {
  const messageQueue = connections.messageQueues.get(pathname) || [];
  const queuedMessage = {
    message,
    timestamp: new Date().toISOString(),
  };

  messageQueue.push(queuedMessage);
  connections.messageQueues.set(pathname, messageQueue);

  logger.info(
    `Queued message for ${pathname}: connection not established yet (queue size: ${messageQueue.length})`
  );

  if (CURRENT_LOG_LEVEL >= LOG_LEVELS.DEBUG) {
    const messageStr = message.toString();
    logger.debug(
      `client -> multiplexer on ${pathname}: ${messageStr} (queued)`
    );
  }

  setupMessageTimeout(pathname, queuedMessage);
}

/**
 * Sets up a timeout for a queued message
 * @param {string} pathname - The connection identifier
 * @param {QueuedMessage} queuedMessage - The queued message
 */
function setupMessageTimeout(pathname, queuedMessage) {
  setTimeout(() => {
    const currentQueue = connections.messageQueues.get(pathname) || [];
    const index = currentQueue.findIndex((m) => m === queuedMessage);

    if (index !== -1) {
      currentQueue.splice(index, 1);
      const upstream = connections.upstreams.get(pathname);
      const url = upstream?.upstreamUrl?.href || `${UPSTREAM_URL}${pathname}`;
      logger.warn(
        `Message for ${url} timed out after ${MESSAGE_QUEUE_TIMEOUT}ms and was discarded`
      );

      notifyMasterAboutDiscardedMessage(pathname, queuedMessage);
    }
  }, MESSAGE_QUEUE_TIMEOUT);
}

/**
 * Notifies the master about a discarded message
 * @param {string} connectionId - The connection identifier
 * @param {QueuedMessage} queuedMessage - The message that was discarded
 */
function notifyMasterAboutDiscardedMessage(connectionId, queuedMessage) {
  for (const master of connections.masters) {
    if (master.type === 'root') {
      const notification = JSON.stringify({
        type: 'message',
        event: 'message-discarded',
        connectionId,
        message: queuedMessage.message.toString(),
        queuedAt: queuedMessage.timestamp,
        reason: 'timeout',
      });

      sendMessage(master.ws, notification, 'multiplexer', 'master');

      if (CURRENT_LOG_LEVEL >= LOG_LEVELS.DEBUG) {
        const messageStr = queuedMessage.message.toString();
        logger.debug(
          `multiplexer -> master: discarded message notification for ${connectionId}: ${messageStr}`
        );
      }
    } else if (master.targetPath === connectionId) {
      // Send notification to specific master connection
      const notification = JSON.stringify({
        type: 'message',
        event: 'message-discarded',
        connectionId,
        message: queuedMessage.message.toString(),
        queuedAt: queuedMessage.timestamp,
        reason: 'timeout',
      });

      sendMessage(
        master.ws,
        notification,
        'multiplexer',
        `${master.type}:${master.targetPath}`
      );
    }
  }
}

/**
 * Handles messages from client to upstream
 * @param {WebSocket} _ws - The client WebSocket connection
 * @param {string} pathname - The connection identifier
 * @param {string | Buffer} message - The message received
 */
function handleClientMessage(_ws, pathname, message) {
  const upstream = connections.upstreams.get(pathname);

  logMessageIfDebug(
    'Client → Upstream',
    pathname,
    message,
    upstream?.upstreamUrl
  );
  notifyMasterAboutMessage('client-to-upstream', pathname, message);

  // Forward to upstream if connected
  if (upstream?.connected) {
    sendMessage(upstream.ws, message, 'multiplexer', upstream.upstreamUrl.href);
  } else {
    queueMessage(pathname, message);
  }
}

/**
 * Handles messages from upstream to client
 * @param {WebSocket} ws - The client WebSocket connection
 * @param {string} pathname - The connection identifier
 * @param {string | Buffer} message - The message received
 */
function handleUpstreamMessage(ws, pathname, message) {
  const upstream = connections.upstreams.get(pathname);
  logMessageIfDebug(
    'Upstream → Client',
    pathname,
    message,
    upstream?.upstreamUrl
  );
  notifyMasterAboutMessage('upstream-to-client', pathname, message);

  // Forward to client
  sendMessage(ws, message, 'multiplexer', `client:${pathname}`);
}

/**
 * Logs a message if debug level is enabled
 * @param {string} direction - The message direction
 * @param {string} pathname - The connection identifier
 * @param {string | Buffer} message - The message to log
 * @param {URL} [upstreamUrl] - The resolved upstream URL (optional)
 */
function logMessageIfDebug(direction, pathname, message, upstreamUrl) {
  if (CURRENT_LOG_LEVEL >= LOG_LEVELS.DEBUG) {
    const messageStr = message.toString();
    if (direction === 'Client → Upstream') {
      logger.debug(`client -> multiplexer:${pathname}: ${messageStr}`);
    } else if (direction === 'Upstream → Client') {
      const url = upstreamUrl?.href || `${UPSTREAM_URL}${pathname}`;
      logger.debug(`${url} -> multiplexer: ${messageStr}`);
    }
  }
}

/**
 * Notifies the master about a message
 * @param {'client-to-upstream'|'upstream-to-client'} direction - The message direction
 * @param {string} connectionId - The connection identifier
 * @param {string | Buffer} message - The message
 */
function notifyMasterAboutMessage(direction, connectionId, message) {
  notifyRootMasters('message', direction, connectionId, {
    message: message.toString(),
  });

  const targetDirection = direction.startsWith('client-to-')
    ? 'upstream'
    : 'client';
  notifyConnectionMasters(connectionId, message, targetDirection);
}

/**
 * Handles client disconnection
 * @param {string} pathname - The connection identifier
 * @param {WebSocket} ws - The client WebSocket that closed
 * @param {number} code - The close code
 * @param {string} reason - The close reason
 */
function handleClientDisconnection(pathname, ws, code, reason) {
  logger.info(
    `Client disconnected: ${pathname}. Code: ${code}, Reason: ${
      reason || 'No reason provided'
    }`
  );

  // A replaced client closes after its successor registered on the same path: leave the successor alone.
  const current = connections.clients.get(pathname);
  if (current && current.ws !== ws) {
    logger.debug(`Ignoring close of a replaced client socket for ${pathname}`);
    return;
  }

  connections.messageQueues.delete(pathname);

  const upstream = connections.upstreams.get(pathname);
  if (upstream) {
    logger.debug(`Closing upstream connection for ${pathname}`);
    upstream.ws.close();
    connections.upstreams.delete(pathname);
  }

  connections.clients.delete(pathname);

  notifyRootMasters('connection', 'client-disconnected', pathname, {
    code,
    reason: reason?.toString(),
  });
}

/**
 * Handles upstream disconnection
 * @param {string} pathname - The connection identifier
 * @param {WebSocket} upstreamWs - The upstream WebSocket that closed
 * @param {number} code - The close code
 * @param {string} reason - The close reason
 */
function handleUpstreamDisconnection(pathname, upstreamWs, code, reason) {
  const closeInfo = {
    code,
    reason: reason?.toString() || 'No reason provided',
    wasClean: code === 1000 || code === 1001,
  };

  logger.info(`Upstream disconnected for client ${pathname}:`, closeInfo);
  logImportantCloseCodes(pathname, code);

  // A replaced upstream (e.g. closed by the CSMS in favour of a newer session) must not tear down the current client.
  if (connections.upstreams.get(pathname)?.ws !== upstreamWs) {
    logger.debug(`Ignoring close of a stale upstream socket for ${pathname}`);
    return;
  }

  connections.messageQueues.delete(pathname);

  if (pathname === '/') {
    notifyRootMasters(
      'connection',
      'upstream-disconnected',
      pathname,
      closeInfo
    );
  }

  const client = connections.clients.get(pathname);
  if (client) {
    logger.debug(
      `Closing client connection for ${pathname} due to upstream disconnect`
    );
    client.ws.close();
    connections.clients.delete(pathname);
  }

  connections.upstreams.delete(pathname);
}

/**
 * Logs important close codes with context
 * @param {string} pathname - The connection identifier
 * @param {number} code - The close code
 */
function logImportantCloseCodes(pathname, code) {
  const closeMessages = {
    1006: `Abnormal closure with upstream ${pathname}`,
    1011: `Unexpected condition prevented upstream ${pathname} from fulfilling request`,
    1012: `Service restart with upstream ${pathname}`,
    1013: `Server overloaded at upstream ${pathname}`,
    1014: `Bad gateway with upstream ${pathname}`,
  };

  if (closeMessages[code]) {
    logger.error(closeMessages[code]);
  }
}

/**
 * Handles upstream connection errors
 * @param {string} pathname - The connection identifier
 * @param {Error} error - The error object
 * @param {URL} [target] - The URL of the upstream that failed
 */
function handleUpstreamError(pathname, error, target) {
  const upstreamUrl = target?.href || `${UPSTREAM_URL}${pathname}`;
  const code = 'code' in error ? error.code : 'unknown';
  const errorInfo = {
    message: error.message,
    code,
    target: upstreamUrl,
    path: pathname,
    time: new Date().toISOString(),
  };

  logger.error(
    `Error on the upstream connection to ${upstreamUrl}:`,
    errorInfo
  );

  logCommonErrorTypes(upstreamUrl, error);

  notifyRootMasters('error', 'upstream-error', pathname, errorInfo);
}

/**
 * Logs common error types with context
 * @param {string} upstreamUrl - The upstream URL
 * @param {Error} error - The error object
 */
function logCommonErrorTypes(upstreamUrl, error) {
  const errorMessages = {
    ECONNREFUSED: `Connection refused to ${upstreamUrl}`,
    ENOTFOUND: `DNS resolution failed for ${upstreamUrl}`,
    ETIMEDOUT: `Connection timed out to ${upstreamUrl}`,
    UNKNOWN: `Unknown error on ${upstreamUrl}`,
  };

  const code = 'code' in error ? error.code : 'UNKNOWN';

  if (errorMessages[code]) {
    logger.error(errorMessages[code]);
  } else if (error.message?.includes('unexpected server response')) {
    logger.error(
      `Unexpected response from ${upstreamUrl}. Server might not support WebSockets.`
    );
  }
}

/**
 * Formats a standardized message for master notifications
 * @param {'message'|'connection'|'error'} type - The type of notification
 * @param {string} event - The specific event or direction
 * @param {string} connectionId - The connection path/id
 * @param {Object} details - Additional event details
 * @returns {string} JSON formatted message
 */
function formatMasterMessage(type, event, connectionId, details = {}) {
  return JSON.stringify({
    type,
    [type === 'message' ? 'direction' : 'event']: event,
    connectionId,
    ...details,
  });
}

/**
 * Sends a notification to all root masters
 * @param {'message'|'connection'|'error'} type - The type of notification
 * @param {string} event - The specific event or direction
 * @param {string} connectionId - The connection path/id
 * @param {Object} details - Additional event details
 */
function notifyRootMasters(type, event, connectionId, details = {}) {
  const message = formatMasterMessage(type, event, connectionId, details);
  for (const master of connections.masters) {
    if (master.type === 'root') {
      sendMessage(master.ws, message, 'multiplexer', 'master');
    }
  }
}

/**
 * Sends a raw message to connection-specific masters
 * @param {string} connectionId - The connection path/id
 * @param {string|Buffer} message - The message to forward
 * @param {'client'|'upstream'} direction - The connection type to notify
 */
function notifyConnectionMasters(connectionId, message, direction) {
  for (const master of connections.masters) {
    if (master.targetPath === connectionId && master.type === direction) {
      sendMessage(
        master.ws,
        message,
        'multiplexer',
        `${master.type}:${master.targetPath}`
      );
    }
  }
}

/**
 * Sets up debug event listeners for WebSocket connections
 * @param {WebSocket} ws - The client WebSocket connection
 * @param {WebSocket} upstreamWs - The upstream WebSocket connection
 * @param {string} pathname - The connection identifier
 */
function setupDebugEventListeners(ws, upstreamWs, pathname) {
  if (CURRENT_LOG_LEVEL >= LOG_LEVELS.DEBUG) {
    ws.on('ping', (data) => {
      logger.debug(
        `client -> multiplexer on ${pathname}: ping (${
          data?.toString() || 'empty'
        })`
      );
    });

    ws.on('pong', (data) => {
      logger.debug(
        `client -> multiplexer on ${pathname}: pong (${
          data?.toString() || 'empty'
        })`
      );
    });

    upstreamWs.on('ping', (data) => {
      const upstream = connections.upstreams.get(pathname);
      const url = upstream?.upstreamUrl?.href || `${UPSTREAM_URL}${pathname}`;
      logger.debug(
        `${url} -> multiplexer: ping (${data?.toString() || 'empty'})`
      );
    });

    upstreamWs.on('pong', (data) => {
      const upstream = connections.upstreams.get(pathname);
      const url = upstream?.upstreamUrl?.href || `${UPSTREAM_URL}${pathname}`;
      logger.debug(
        `${url} -> multiplexer: pong (${data?.toString() || 'empty'})`
      );
    });
  }
}

/**
 * Handles unexpected responses from upstream
 * @param {string} pathname - The connection identifier
 * @param {http.IncomingMessage} response - The HTTP response
 * @param {URL} [target] - The URL of the upstream that answered
 */
function handleUnexpectedResponse(pathname, response, target) {
  const upstreamUrl = target?.href || `${UPSTREAM_URL}${pathname}`;
  const statusInfo = {
    code: response.statusCode,
    message: response.statusMessage,
    url: upstreamUrl,
    time: new Date().toISOString(),
  };

  logger.error(`Unexpected response from upstream ${pathname}:`, statusInfo);

  if (response.statusCode === 401 || response.statusCode === 403) {
    logger.error(`Authentication failed for ${upstreamUrl}`);
  } else if (response.statusCode === 404) {
    logger.error(`Resource not found at ${upstreamUrl}`);
  } else if (response.statusCode >= 500) {
    logger.error(`Server error at ${upstreamUrl}`);
  }

  if (pathname === '/') {
    notifyRootMasters('error', 'unexpected-response', pathname, statusInfo);
  }
}

/**
 * Filters and transforms headers for the upstream connection
 * @param {Object} headers - The original request headers
 * @returns {Object} The filtered and transformed headers
 */
function prepareUpstreamHeaders(headers) {
  const filteredHeaders = {};

  // Headers to forward
  const forwardHeaders = [
    'authorization',
    'sec-websocket-protocol',
    'sec-websocket-version',
    'user-agent',
    'x-request-id',
    'x-real-ip',
    'x-forwarded-for',
    'x-forwarded-host',
    'x-forwarded-port',
    'x-forwarded-proto',
    'x-forwarded-scheme',
    'x-scheme',
  ];

  // Copy allowed headers
  for (const header of forwardHeaders) {
    if (headers[header]) {
      filteredHeaders[header] = headers[header];
    }
  }

  // Add our own headers
  filteredHeaders['x-proxied-by'] = 'websocket-multiplexer';
  filteredHeaders['x-proxy-time'] = new Date().toISOString();

  return filteredHeaders;
}

/**
 * Closes both legs of the connection registered on a path
 * @param {string} pathname - The connection identifier
 */
function closeExistingConnection(pathname) {
  const existingClient = connections.clients.get(pathname);
  const existingUpstream = connections.upstreams.get(pathname);

  // Their close handlers fire later and ignore sockets that are no longer registered.
  connections.clients.delete(pathname);
  connections.upstreams.delete(pathname);
  connections.messageQueues.delete(pathname);

  if (
    existingUpstream &&
    (existingUpstream.ws.readyState === WebSocket.OPEN ||
      existingUpstream.ws.readyState === WebSocket.CONNECTING)
  ) {
    existingUpstream.ws.close(1000, 'Client connection replaced');
  }

  if (existingClient?.ws.readyState === WebSocket.OPEN) {
    existingClient.ws.close(
      1000,
      'Connection replaced by new client on same path'
    );
  }
}

/**
 * Watches a held station socket: notices its departure and keeps any bytes it sends too early
 * @param {import('node:net').Socket} socket - The station socket
 * @param {() => void} onGone - Called if the station leaves while held
 * @returns {(handBack: boolean) => void} Stops watching; handBack queues the early bytes back for ws
 */
function holdStationSocket(socket, onGone) {
  /** @type {Buffer[]} */
  const early = [];
  const onData = (chunk) => early.push(chunk);
  const detach = () => {
    socket.removeListener('data', onData);
    socket.removeListener('end', gone);
    socket.removeListener('close', gone);
  };
  function gone() {
    detach();
    socket.destroy();
    onGone();
  }

  // Reading is the only way to notice a FIN on a socket handed over by the HTTP server.
  socket.on('data', onData);
  socket.once('end', gone);
  socket.once('close', gone);

  return (handBack) => {
    detach();
    if (handBack) {
      // Paused so the bytes wait for the ws 'data' listener; the caller resumes once ws owns the socket.
      socket.pause();
      if (early.length > 0) socket.unshift(Buffer.concat(early));
    }
  };
}

/**
 * Holds a station handshake until its upstream answers, then completes or refuses it accordingly
 * @param {http.IncomingMessage} req - The station upgrade request
 * @param {(verified: boolean, code?: number) => void} done - The ws verifyClient callback
 */
async function holdClientHandshake(req, done) {
  /** @type {PendingClient | null} */
  let attempt = null;
  try {
    attempt = createPendingClient(req, done);
    await connectPendingClient(attempt);
  } catch (error) {
    logger.error('Error setting up client connection:', error);
    if (attempt) rejectPendingClient(attempt, 500);
    else done(false, 500);
  }
}

/**
 * Starts holding a station handshake
 * @param {http.IncomingMessage} req - The station upgrade request
 * @param {(verified: boolean, code?: number) => void} done - The ws verifyClient callback
 * @returns {PendingClient} The held handshake
 */
function createPendingClient(req, done) {
  const pathname = new URL(req.url, UPSTREAM_URL).pathname;
  const ip = req.socket.remoteAddress;

  logger.info(
    `Client handshake on ${pathname} from ${ip}, waiting for upstream`
  );
  logger.info('Client connection headers:', redactHeaders(req.headers));

  /** @type {PendingClient} */
  const attempt = {
    req,
    done,
    pathname,
    ip,
    generation: ++handshakeCounter,
    credentialDigest: digestCredential(req.headers.authorization),
    state: 'pending',
    upstreamWs: null,
    upstreamUrl: null,
    releaseSocket: () => {},
  };
  attempt.releaseSocket = holdStationSocket(req.socket, () => {
    if (attempt.state !== 'pending') return;
    attempt.state = 'rejected';
    logger.info(`Client ${pathname} left before its upstream answered`);
    attempt.upstreamWs?.terminate();
  });
  return attempt;
}

/**
 * Opens the upstream of a held handshake; the station is answered once the upstream is
 * @param {PendingClient} attempt - The held handshake
 */
async function connectPendingClient(attempt) {
  const { req, pathname } = attempt;

  // Same non-empty credential as the connected station: it is reconnecting, and a CSMS refusing duplicate identities needs the old session gone first.
  const existing = connections.clients.get(pathname);
  if (
    existing &&
    isSameCredential(existing.credentialDigest, attempt.credentialDigest)
  ) {
    logger.warn(
      `Client already connected on path ${pathname} with the same credentials. Closing existing connection.`
    );
    closeExistingConnection(pathname);
  }

  const upstreamUrl = await resolveUpstreamUrl(pathname);
  if (attempt.state !== 'pending') return;
  attempt.upstreamUrl = upstreamUrl;

  const protocol_string = req.headers['sec-websocket-protocol'] || '';
  const protocols = protocol_string
    .split(/,\s*/)
    .filter((p) => p.trim() !== '');

  const options = {
    headers: prepareUpstreamHeaders(req.headers),
  };
  logger.info(
    `Connecting to upstream: ${
      upstreamUrl.href
    } using protocols: ${protocols} and options: ${JSON.stringify({
      headers: redactHeaders(options.headers),
    })}`
  );
  const upstreamWs = new WebSocket(
    upstreamUrl.href,
    protocols.length > 0 ? protocols : undefined,
    options
  );
  attempt.upstreamWs = upstreamWs;

  if (CURRENT_LOG_LEVEL >= LOG_LEVELS.DEBUG) {
    upstreamWs.on('upgrade', (response) => {
      logger.debug(`Upstream ${pathname} upgrade:`, {
        headers: response.headers,
        status: `${response.statusCode} ${response.statusMessage}`,
      });
    });
  }

  // Always handled and always aborted: a listener that only logs keeps ws from ending the upstream handshake.
  upstreamWs.on('unexpected-response', (_request, response) => {
    handleUnexpectedResponse(pathname, response, upstreamUrl);
    rejectPendingClient(
      attempt,
      stationStatusForUpstreamRefusal(response.statusCode),
      `upstream answered HTTP ${response.statusCode}`
    );
    upstreamWs.terminate();
  });

  upstreamWs.on('open', () => acceptPendingClient(attempt));

  upstreamWs.on('error', (error) => {
    if (attempt.state === 'rejected') {
      logger.debug(`Upstream attempt for ${pathname} ended: ${error.message}`);
      return;
    }
    handleUpstreamError(pathname, error, upstreamUrl);
    rejectPendingClient(attempt, 502);
  });

  upstreamWs.on('close', (code, reason) => {
    if (attempt.state === 'accepted') {
      handleUpstreamDisconnection(
        pathname,
        upstreamWs,
        code,
        reason?.toString()
      );
    }
  });
}

/**
 * Maps an upstream handshake refusal to the HTTP status sent to the station
 * @param {number} upstreamStatus - The status the upstream answered with
 * @returns {number} 401 for any 4xx, the same status for a 5xx, 502 otherwise
 */
function stationStatusForUpstreamRefusal(upstreamStatus) {
  // Any 4xx makes a station fall back to its previous network profile; passing 404 vs 401 through would tell unknown serials from wrong passwords.
  if (upstreamStatus >= 400 && upstreamStatus < 500) return 401;
  if (upstreamStatus >= 500 && upstreamStatus < 600) return upstreamStatus;
  return 502;
}

/**
 * Refuses a held handshake with an HTTP status; the connection already on the path is left untouched
 * @param {PendingClient} attempt - The held handshake
 * @param {number} status - The HTTP status sent to the station
 * @param {string} [cause] - Why, appended to the log line
 */
function rejectPendingClient(attempt, status, cause) {
  if (attempt.state !== 'pending') return;
  attempt.state = 'rejected';
  attempt.releaseSocket(false);

  logger.warn(
    `Rejecting client handshake on ${attempt.pathname} with HTTP ${status}${
      cause ? ` (${cause})` : ''
    }`
  );

  const upstreamWs = attempt.upstreamWs;
  if (upstreamWs?.readyState === WebSocket.OPEN) {
    upstreamWs.close(1000, 'Client handshake rejected');
  } else if (upstreamWs?.readyState === WebSocket.CONNECTING) {
    upstreamWs.terminate();
  }

  attempt.done(false, status);
}

/**
 * Completes a held handshake once its upstream accepted it
 * @param {PendingClient} attempt - The held handshake
 */
function acceptPendingClient(attempt) {
  const { req, pathname, upstreamWs } = attempt;
  if (attempt.state !== 'pending') {
    upstreamWs.close(1000, 'Client handshake abandoned');
    return;
  }

  const current = connections.clients.get(pathname);
  if (current && current.generation > attempt.generation) {
    logger.warn(
      `A newer connection on ${pathname} was accepted first, rejecting this one`
    );
    rejectPendingClient(attempt, 409);
    return;
  }

  attempt.state = 'accepted';
  attempt.releaseSocket(true);
  pendingClients.set(req, attempt);
  // ws completes the handshake synchronously and emits 'connection', which takes the entry.
  attempt.done(true);
  req.socket.resume();

  if (pendingClients.delete(req)) {
    // ws dropped the handshake because the station socket is gone: nothing would ever close this upstream.
    attempt.state = 'rejected';
    upstreamWs.close(1000, 'Client left before the handshake completed');
  }
}

/**
 * Picks the station subprotocol: the one its upstream accepted, so both legs speak the same OCPP version
 * @param {Set<string>} protocols - The subprotocols offered by the station
 * @param {http.IncomingMessage} req - The station upgrade request
 * @returns {string | false} The selected subprotocol
 */
function selectClientProtocol(protocols, req) {
  const upstreamProtocol = pendingClients.get(req)?.upstreamWs?.protocol;
  if (upstreamProtocol && protocols.has(upstreamProtocol)) {
    return upstreamProtocol;
  }
  return protocols.values().next().value || false;
}

/**
 * Registers a station whose handshake just completed, replacing the connection on its path if any
 * @param {WebSocket} ws - The client WebSocket connection
 * @param {http.IncomingMessage} req - The HTTP request
 */
function registerClientConnection(ws, req) {
  const attempt = pendingClients.get(req);
  pendingClients.delete(req);
  if (!attempt) {
    logger.error('Client handshake completed without an upstream');
    ws.close(1011, 'Server error during connection setup');
    return;
  }

  const { pathname, ip, upstreamWs, upstreamUrl } = attempt;

  if (connections.clients.has(pathname)) {
    logger.warn(
      `Client already connected on path ${pathname}. Closing existing connection.`
    );
    closeExistingConnection(pathname);
  }

  logger.info(`Client connected: ${pathname} from ${ip}`);
  logger.info(`Upstream connected for client ${pathname}`);
  logger.debug(`Upstream connection for ${pathname}:`, {
    url: upstreamUrl.href,
    protocol: upstreamWs.protocol,
  });

  /** @type {ClientConnection} */
  const client = {
    ws,
    upstreamId: pathname,
    connected: true,
    upstreamUrl,
    generation: attempt.generation,
    credentialDigest: attempt.credentialDigest,
    alive: true,
  };
  connections.clients.set(pathname, client);

  // Any frame from the station proves the socket is alive, not only the pong to our heartbeat ping.
  const markAlive = () => {
    client.alive = true;
  };
  ws.on('pong', markAlive);
  ws.on('ping', markAlive);
  ws.on('message', markAlive);

  connections.upstreams.set(pathname, {
    ws: upstreamWs,
    clientId: pathname,
    connected: true,
    upstreamUrl,
  });

  notifyRootMasters('connection', 'client-connected', pathname, {
    ip,
    headers: redactHeaders(req.headers),
  });

  // Forward messages from client to upstream
  ws.on('message', (message) =>
    handleClientMessage(ws, pathname, message.toString())
  );

  // Forward messages from upstream to client
  upstreamWs.on('message', (message) =>
    handleUpstreamMessage(ws, pathname, message.toString())
  );

  // Handle client disconnection
  ws.on('close', (code, reason) =>
    handleClientDisconnection(pathname, ws, code, reason?.toString())
  );

  ws.on('error', (error) => {
    logger.error(`Client error (${pathname}):`, error);
  });

  // Set up debug event listeners if needed
  setupDebugEventListeners(ws, upstreamWs, pathname);

  if (pathname === '/') {
    sendStatusToMaster(upstreamWs);
  }
}

/**
 * Gracefully shuts down the server
 */
function shutdownServer() {
  logger.info('Shutting down server...');

  if (stationHeartbeat) {
    clearInterval(stationHeartbeat);
    stationHeartbeat = null;
  }

  // Close all connections
  logger.debug(`Closing ${connections.clients.size} client connections`);
  for (const client of connections.clients.values()) {
    logger.debug(`Closing client connection for ${client.upstreamId}`);
    client.ws.close(1000, 'Server shutting down');
  }

  logger.debug(`Closing ${connections.upstreams.size} upstream connections`);
  for (const upstream of connections.upstreams.values()) {
    logger.debug(`Closing upstream connection for ${upstream.clientId}`);
    upstream.ws.close(1000, 'Server shutting down');
  }

  logger.debug(`Closing ${connections.masters.size} master connections`);
  for (const master of connections.masters) {
    logger.debug(`Closing master connection for ${master.path}`);
    master.ws.close(1000, 'Server shutting down');
  }

  server.close(() => {
    masterServer.close(() => {
      logger.info('Servers shut down');
      process.exit(0);
    });
  });
}

/**
 * Sets up process-level event handlers
 */
function setupProcessEventHandlers() {
  // Handle server shutdown
  process.on('SIGINT', shutdownServer);

  // Log uncaught exceptions
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception:', error);
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled rejection at:', promise, 'reason:', reason);
  });
}

/**
 * Main function to initialize and start the WebSocket multiplexer
 */
function main() {
  const { wss, masterWss } = initializeWebSocketServers();

  setupServerEventListeners(wss);
  setupMasterServerEventListeners(masterWss);

  // Handle master control connections
  masterWss.on('connection', setupMasterConnection);

  // Handle station connections whose upstream already accepted them
  wss.on('connection', (ws, req) => {
    try {
      registerClientConnection(ws, req);
    } catch (error) {
      logger.error('Error setting up client connection:', error);
      ws.close(1011, 'Server error during connection setup');
    }
  });

  setupProcessEventHandlers();

  stationHeartbeat = startStationHeartbeat();

  // Start the servers
  server.listen(PORT, () => {
    logger.info(`WebSocket multiplexer running on port ${PORT}`);
    logger.info(`Upstream URL: ${UPSTREAM_URL}`);
    logger.info(`Logging level: ${LOG_LEVEL}`);
  });

  masterServer.listen(MASTER_PORT, () => {
    logger.info(`Master control available at: ws://localhost:${MASTER_PORT}`);
  });
}

// Start the application
main();
