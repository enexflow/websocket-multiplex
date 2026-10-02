const WebSocket = require('ws');
const http = require('node:http');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A minimal fake OCPP upstream server: accepts any path, records every
 * message it receives per-path, and lets a test (or a human, via
 * docker-compose) send messages back to a specific connection or broadcast
 * to all of them.
 */
class TestServer {
  constructor(port) {
    this.port = port;
    this.server = http.createServer();
    this.wss = new WebSocket.Server({ server: this.server });
    this.messageQueue = [];
    /** @type {Map<string, WebSocket>} */
    this.connections = new Map();
    /** @type {http.IncomingHttpHeaders} */
    this.lastRequestHeaders = {};

    this.wss.on('connection', (ws, req) => {
      console.log(
        `[TEST SERVER] Client connected on path: ${
          req.url
        } with headers: ${JSON.stringify(req.headers)}`
      );
      this.connections.set(req.url, ws);
      this.lastRequestHeaders = req.headers;

      ws.on('message', (message) => {
        const messageStr = message.toString();
        this.messageQueue.push(messageStr);
      });

      ws.on('close', () => {
        this.connections.delete(req.url);
      });
    });
  }

  send(message, path = null) {
    if (path) {
      const client = this.connections.get(path);
      if (client && client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    } else {
      for (const client of this.wss.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(message);
        }
      }
    }
  }

  async receiveMessage(timeoutMs = 1000) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      console.debug(
        `[TEST SERVER] Receiving message from port ${this.port}`,
        this.messageQueue
      );
      if (this.messageQueue.length > 0) {
        return this.messageQueue.shift();
      }
      await wait(50);
    }
    throw new Error(`Timeout waiting for message on port ${this.port}`);
  }

  start() {
    return new Promise((resolve) => {
      this.server.listen(this.port, () => {
        console.log(
          `[TEST SERVER] WebSocket test server running on port ${this.port}`
        );
        resolve();
      });
    });
  }

  stop() {
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.close();
      }
    }
    this.server.close();
  }
}

module.exports = { TestServer };

// Runnable standalone (e.g. as the `upstream-mock` service in
// docker-compose): just keep accepting connections and logging traffic.
if (require.main === module) {
  const port = Number(process.env.PORT) || 9000;
  const server = new TestServer(port);
  server.start();

  (async () => {
    for (;;) {
      try {
        const message = await server.receiveMessage(1000);
        console.log(`[TEST SERVER] received: ${message}`);
      } catch {
        // No message in the last second - keep polling.
      }
    }
  })();

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      server.stop();
      process.exit(0);
    });
  }
}
