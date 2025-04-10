const WebSocket = require('ws');
const http = require('node:http');
const url = require('node:url');

// Configuration
const PORT = process.env.PORT || 8080;
const MASTER_PORT = process.env.MASTER_PORT || 8081;
const UPSTREAM_URL = process.env.UPSTREAM_URL || 'ws://localhost:9000';
const LOG_LEVEL = process.env.LOG_LEVEL || 'INFO';
const MESSAGE_QUEUE_TIMEOUT =
  Number(process.env.MESSAGE_QUEUE_TIMEOUT) || 30000; // 30 seconds default

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

/**
 * Logger utility for consistent logging with level control
 */
const logger = {
  error: (message, ...args) => {
    if (CURRENT_LOG_LEVEL >= LOG_LEVELS.ERROR) {
      console.error(`[ERROR] ${message}`, ...args);
    }
  },
  warn: (message, ...args) => {
    if (CURRENT_LOG_LEVEL >= LOG_LEVELS.WARN) {
      console.warn(`[WARN] ${message}`, ...args);
    }
  },
  info: (message, ...args) => {
    if (CURRENT_LOG_LEVEL >= LOG_LEVELS.INFO) {
      console.log(`[INFO] ${message}`, ...args);
    }
  },
  debug: (message, ...args) => {
    if (CURRENT_LOG_LEVEL >= LOG_LEVELS.DEBUG) {
      console.log(`[DEBUG] ${message}`, ...args);
    }
  },
};

// Create HTTP servers
const server = http.createServer();
const masterServer = http.createServer();

// WebSocket server options with logging
const wsOptions = {
  server,
  perMessageDeflate: true,
};

const masterWsOptions = {
  server: masterServer,
  perMessageDeflate: true,
};

/**
 * Global connection store for tracking all active connections
 * @typedef {{ ws: WebSocket, connected: boolean, upstreamId: string }} ClientConnection
 * @typedef {{ ws: WebSocket, connected: boolean, clientId: string }} UpstreamConnection
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
    const truncatedMsg =
      messageStr.length > 200
        ? `${messageStr.substring(0, 200)}... (${messageStr.length} bytes)`
        : messageStr;
    logger.debug(`${source} -> ${target}: ${truncatedMsg}`);
  }
}

/**
 * Handles message injection from master to specified targets
 * @param {{ target: string, message: string | Buffer }} data - The message data containing target and message
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
 * Handles messages received from the master connection
 * @param { MasterConnection } masterConnection - The master WebSocket connection
 * @param {string} message - The message received
 */
function handleMasterMessage(masterConnection, message) {
  const { path, type, targetPath, ws } = masterConnection;
  if (type === 'root') {
    try {
      /** @type {{ type: string, target: string, message: string }} */
      const data = JSON.parse(message);
      const target = data.target;
      const contents = data.message;
      logger.debug(
        `multiplexer <- master client: ${type} ${target} ${contents}`
      );

      if (data.type === 'inject') {
        handleMasterInjection(data);
      }
    } catch (error) {
      logger.error('Error processing master message:', error);
    }
  } else {
    if (type === 'client') {
      const client = connections.clients.get(targetPath);
      if (client?.connected) {
        sendMessage(client.ws, message, 'master', `client:${targetPath}`);
      }
    } else if (type === 'upstream') {
      const upstream = connections.upstreams.get(targetPath);
      if (upstream?.connected) {
        sendMessage(upstream.ws, message, 'master', `upstream:${targetPath}`);
      }
    }
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
      `Master control disconnected from ${pathname}. Code: ${code}, Reason: ${reason || 'No reason provided'}`
    );
    connections.masters.delete(masterConnection);
  });

  ws.on('error', (error) => {
    logger.error('Master connection error:', error);
  });
}

/**
 * Processes queued messages from a client to an upstream
 * @param {string} pathname - The connection identifier
 */
function processQueuedMessages(pathname) {
  const upstream = connections.upstreams.get(pathname);
  const messageQueue = connections.messageQueues.get(pathname) || [];

  if (messageQueue.length > 0) {
    logger.info(
      `Processing ${messageQueue.length} queued messages for ${pathname}`
    );
    while (messageQueue.length > 0) {
      const queuedMessage = messageQueue.shift();
      sendMessage(
        upstream.ws,
        queuedMessage.message,
        'multiplexer',
        `${UPSTREAM_URL}${pathname}`
      );

      if (CURRENT_LOG_LEVEL >= LOG_LEVELS.DEBUG) {
        const messageStr = queuedMessage.message.toString();
        const truncatedMsg =
          messageStr.length > 200
            ? `${messageStr.substring(0, 200)}... (${messageStr.length} bytes)`
            : messageStr;
        logger.debug(
          `multiplexer -> ${UPSTREAM_URL}${pathname}: ${truncatedMsg} (dequeued)`
        );
      }

      notifyMasterAboutDequeuedMessage(pathname, queuedMessage);
    }
  }
}

/**
 * Notifies the master about a dequeued message
 * @param {string} connectionId - The connection identifier
 * @param {QueuedMessage} queuedMessage - The message that was dequeued
 */
function notifyMasterAboutDequeuedMessage(connectionId, queuedMessage) {
  notifyRootMasters('message', 'client-to-upstream-dequeued', connectionId, {
    message: queuedMessage.message.toString(),
    queuedAt: queuedMessage.timestamp,
    sentAt: new Date().toISOString(),
  });

  notifyConnectionMasters(connectionId, queuedMessage.message, 'upstream');
}

/**
 * Handles upstream connection establishment
 * @param {WebSocket} upstreamWs - The upstream WebSocket connection
 * @param {string} pathname - The connection identifier
 */
function handleUpstreamOpen(upstreamWs, pathname) {
  logger.info(`Upstream connected for client ${pathname}`);
  const client = connections.clients.get(pathname);
  const upstream = connections.upstreams.get(pathname);

  if (client) client.connected = true;
  if (upstream) upstream.connected = true;

  // Log connection details
  logger.debug(`Upstream connection for ${pathname}:`, {
    url: UPSTREAM_URL + pathname,
    protocol: upstreamWs.protocol,
  });

  processQueuedMessages(pathname);

  // Notify master
  if (pathname === '/') {
    sendStatusToMaster(upstreamWs);
  }
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
    const truncatedMsg =
      messageStr.length > 200
        ? `${messageStr.substring(0, 200)}... (${messageStr.length} bytes)`
        : messageStr;
    logger.debug(
      `client -> multiplexer on ${pathname}: ${truncatedMsg} (queued)`
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
      logger.warn(
        `Message for ${UPSTREAM_URL + pathname} timed out after ${MESSAGE_QUEUE_TIMEOUT}ms and was discarded`
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
        const truncatedMsg =
          messageStr.length > 200
            ? `${messageStr.substring(0, 200)}... (${messageStr.length} bytes)`
            : messageStr;
        logger.debug(
          `multiplexer -> master: discarded message notification for ${connectionId}: ${truncatedMsg}`
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
 * @param {WebSocket} ws - The client WebSocket connection
 * @param {string} pathname - The connection identifier
 * @param {string | Buffer} message - The message received
 */
function handleClientMessage(ws, pathname, message) {
  const upstream = connections.upstreams.get(pathname);

  logMessageIfDebug('Client → Upstream', pathname, message);
  notifyMasterAboutMessage('client-to-upstream', pathname, message);

  // Forward to upstream if connected
  if (upstream?.connected) {
    sendMessage(
      upstream.ws,
      message,
      'multiplexer',
      `${UPSTREAM_URL}${pathname}`
    );
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
  logMessageIfDebug('Upstream → Client', pathname, message);
  notifyMasterAboutMessage('upstream-to-client', pathname, message);

  // Forward to client
  sendMessage(ws, message, 'multiplexer', `client:${pathname}`);
}

/**
 * Logs a message if debug level is enabled
 * @param {string} direction - The message direction
 * @param {string} pathname - The connection identifier
 * @param {string | Buffer} message - The message to log
 */
function logMessageIfDebug(direction, pathname, message) {
  if (CURRENT_LOG_LEVEL >= LOG_LEVELS.DEBUG) {
    const messageStr = message.toString();
    const truncatedMsg =
      messageStr.length > 200
        ? `${messageStr.substring(0, 200)}... (${messageStr.length} bytes)`
        : messageStr;

    if (direction === 'Client → Upstream') {
      logger.debug(`client -> multiplexer:${pathname}: ${truncatedMsg}`);
      logger.debug(
        `multiplexer -> ${UPSTREAM_URL}${pathname}: ${truncatedMsg}`
      );
    } else if (direction === 'Upstream → Client') {
      logger.debug(
        `${UPSTREAM_URL}${pathname} -> multiplexer: ${truncatedMsg}`
      );
      logger.debug(`multiplexer -> client:${pathname}: ${truncatedMsg}`);
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
 * @param {number} code - The close code
 * @param {string} reason - The close reason
 */
function handleClientDisconnection(pathname, code, reason) {
  logger.info(
    `Client disconnected: ${pathname}. Code: ${code}, Reason: ${reason || 'No reason provided'}`
  );

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
 * @param {number} code - The close code
 * @param {string} reason - The close reason
 */
function handleUpstreamDisconnection(pathname, code, reason) {
  const closeInfo = {
    code,
    reason: reason?.toString() || 'No reason provided',
    wasClean: code === 1000 || code === 1001,
  };

  logger.info(`Upstream disconnected for client ${pathname}:`, closeInfo);

  connections.messageQueues.delete(pathname);
  logImportantCloseCodes(pathname, code);

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
 */
function handleUpstreamError(pathname, error) {
  const upstreamUrl = UPSTREAM_URL + pathname;
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
        `client -> multiplexer on ${pathname}: ping (${data?.toString() || 'empty'})`
      );
    });

    ws.on('pong', (data) => {
      logger.debug(
        `client -> multiplexer on ${pathname}: pong (${data?.toString() || 'empty'})`
      );
    });

    upstreamWs.on('ping', (data) => {
      logger.debug(
        `${UPSTREAM_URL}${pathname} -> multiplexer: ping (${data?.toString() || 'empty'})`
      );
    });

    upstreamWs.on('pong', (data) => {
      logger.debug(
        `${UPSTREAM_URL}${pathname} -> multiplexer: pong (${data?.toString() || 'empty'})`
      );
    });

    setupAdvancedDebugListeners(upstreamWs, pathname);
  }
}

/**
 * Sets up advanced debug event listeners for upstream connections
 * @param {WebSocket} upstreamWs - The upstream WebSocket connection
 * @param {string} pathname - The connection identifier
 */
function setupAdvancedDebugListeners(upstreamWs, pathname) {
  upstreamWs.on('unexpected-response', (request, response) => {
    handleUnexpectedResponse(pathname, response);
  });

  upstreamWs.on('upgrade', (response) => {
    if (CURRENT_LOG_LEVEL >= LOG_LEVELS.DEBUG) {
      logger.debug(`Upstream ${pathname} upgrade:`, {
        headers: response.headers,
        status: `${response.statusCode} ${response.statusMessage}`,
      });
    }
  });
}

/**
 * Handles unexpected responses from upstream
 * @param {string} pathname - The connection identifier
 * @param {http.IncomingMessage} response - The HTTP response
 */
function handleUnexpectedResponse(pathname, response) {
  const upstreamUrl = UPSTREAM_URL + pathname;
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
 * Sets up a new client connection and its corresponding upstream connection
 * @param {WebSocket} ws - The client WebSocket connection
 * @param {http.IncomingMessage} req - The HTTP request
 */
function setupClientConnection(ws, req) {
  const ip = req.socket.remoteAddress;
  const pathname = new URL(req.url, UPSTREAM_URL).pathname;

  logger.info(`Client connected: ${pathname} from ${ip}`);
  logger.info('Client connection headers:', req.headers);

  // Initialize message queue for this connection
  connections.messageQueues.set(pathname, []);

  // Connect to upstream
  const upstreamUrl = UPSTREAM_URL + pathname;
  const protocol_string = req.headers['sec-websocket-protocol'] || '';
  const protocols = protocol_string
    .split(/,\s*/)
    .filter((p) => p.trim() !== '');

  const options = {
    headers: prepareUpstreamHeaders(req.headers),
  };
  logger.info(
    `Connecting to upstream: ${upstreamUrl} using protocols: ${protocols} and options: ${JSON.stringify(options)}`
  );
  const upstreamWs = new WebSocket(
    upstreamUrl,
    protocols.length > 0 ? protocols : undefined,
    options
  );

  // Store connection info
  connections.clients.set(pathname, {
    ws,
    upstreamId: pathname,
    connected: false,
  });

  connections.upstreams.set(pathname, {
    ws: upstreamWs,
    clientId: pathname,
    connected: false,
  });

  // Handle upstream connection
  upstreamWs.on('open', () => handleUpstreamOpen(upstreamWs, pathname));

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
    handleClientDisconnection(pathname, code, reason?.toString())
  );

  // Handle upstream disconnection
  upstreamWs.on('close', (code, reason) =>
    handleUpstreamDisconnection(pathname, code, reason?.toString())
  );

  // Handle errors
  ws.on('error', (error) => {
    logger.error(`Client error (${pathname}):`, error);
  });

  upstreamWs.on('error', (error) => handleUpstreamError(pathname, error));

  // Set up debug event listeners if needed
  setupDebugEventListeners(ws, upstreamWs, pathname);
}

/**
 * Gracefully shuts down the server
 */
function shutdownServer() {
  logger.info('Shutting down server...');

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

  // Handle new WebSocket connections
  wss.on('connection', setupClientConnection);

  setupProcessEventHandlers();

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
