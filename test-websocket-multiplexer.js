const WebSocket = require('ws');
const http = require('node:http');
const { spawn, exec } = require('node:child_process');
const assert = require('node:assert');
const { SIGINT } = require('node:constants');

// Configuration
const CONFIG = {
  TEST_PORT: 9000,
  PROXY_PORT: 8080,
  MASTER_PORT: 8081,
  TEST_PATH: '/test-connection',
  TIMEOUT_MS: 5000,
};

// Global reference to the test runner for cleanup
/** @type {TestRunner} */
let globalTestRunner = null;

// Function to kill processes using specific ports
function killProcessOnPort(port) {
  return new Promise((resolve) => {
    exec(`lsof -i :${port} -t`, (error, stdout) => {
      if (error || !stdout.trim()) {
        // No process found on this port or error occurred
        resolve();
        return;
      }

      const pids = stdout.trim().split('\n');
      console.log(`Found processes using port ${port}: ${pids.join(', ')}`);

      // Kill each process
      for (const pid of pids) {
        try {
          process.kill(Number.parseInt(pid, 10), 'SIGKILL');
          console.log(`Killed process ${pid} on port ${port}`);
        } catch (err) {
          console.error(`Failed to kill process ${pid}:`, err.message);
        }
      }

      // Give some time for the ports to be released
      setTimeout(resolve, 500);
    });
  });
}

// Setup signal handlers for proper cleanup
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    console.log(`\nReceived ${signal}, cleaning up...`);
    if (globalTestRunner) {
      globalTestRunner.cleanup();
    }
    process.exit(1);
  });
}

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('\nUncaught exception:', error);
  if (globalTestRunner) {
    globalTestRunner.cleanup();
  }
  process.exit(1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('\nUnhandled promise rejection:', reason);
  if (globalTestRunner) {
    globalTestRunner.cleanup();
  }
  process.exit(1);
});

// Helper functions
function randomMessage(prefix) {
  return `${prefix} ${Math.random().toString(36).substring(2, 15)}`;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Test results tracking
const testResults = {
  serverReceivedMessages: [],
  clientReceivedMessages: [],
  masterReceivedMessages: [],
  masterRawClientMessages: [],
  masterRawUpstreamMessages: [],
  masterInjectionReceived: false,
  masterStatusReceived: false,
  masterConnectionEvents: [],
  allTestsPassed: false,
};

// Test server implementation
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
      console.log(`[TEST SERVER] Client connected on path: ${req.url} with headers: ${JSON.stringify(req.headers)}`);
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

// Multiplexer process manager
class MultiplexerProcess {
  constructor(config) {
    this.config = config;
    this.process = null;
  }

  start() {
    const env = {
      ...process.env,
      PORT: this.config.PROXY_PORT.toString(),
      MASTER_PORT: this.config.MASTER_PORT.toString(),
      UPSTREAM_URL: `ws://localhost:${this.config.TEST_PORT}`,
      LOG_LEVEL: 'DEBUG',
    };

    return new Promise((resolve) => {
      this.process = spawn('node', ['websocket-multiplex.js'], { env });

      this.process.stdout.on('data', (data) => {
        console.log(`[MULTIPLEXER] ${data.toString().trim()}`);
        if (data.toString().includes('multiplexer running')) {
          resolve();
        }
      });

      this.process.stderr.on('data', (data) => {
        console.error(`[MULTIPLEXER ERROR] ${data.toString().trim()}`);
      });

      this.process.on('exit', (code, signal) => {
        console.log(
          `[MULTIPLEXER] Process exited with code ${code} and signal ${signal}`
        );
      });
    });
  }

  stop() {
    if (this.process) {
      console.log('[MULTIPLEXER] Killing multiplexer process');
      try {
        // First try SIGINT
        const killed = this.process.kill(SIGINT);
        if (!killed) {
          // If SIGINT fails, try SIGTERM
          const terminated = this.process.kill('SIGTERM');
          if (!terminated) {
            // If SIGTERM fails, try SIGKILL as a last resort
            this.process.kill('SIGKILL');
          }
        }
      } catch (error) {
        console.error('[MULTIPLEXER] Failed to kill process:', error);
      }
      this.process = null;
    }
  }
}

// Master client implementation
class MasterClient {
  constructor(port, path = '/') {
    this.port = port;
    this.path = path;
    this.ws = null;
    this.messageQueue = [];
  }

  connect() {
    this.ws = new WebSocket(`ws://localhost:${this.port}${this.path}`);

    this.ws.on('open', () => {
      console.log(
        `[MASTER CLIENT] Connected to multiplexer master port on path ${this.path}`
      );
    });

    this.ws.on('message', (message) => {
      this.messageQueue.push(message.toString());
    });

    this.ws.on('error', (error) => {
      console.error('[MASTER CLIENT] Error:', error);
    });
  }

  async receiveMessage(timeoutMs = 1000) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      if (this.messageQueue.length > 0) {
        return this.messageQueue.shift();
      }
      await wait(50);
    }
    throw new Error('Timeout waiting for message');
  }

  sendRawMessage(message) {
    this.ws.send(message);
  }

  testInjections() {
    // Test all injection types
    const injections = [
      {
        type: 'inject',
        target: 'all-clients',
        message: 'Broadcast to all clients',
      },
      {
        type: 'inject',
        target: 'all-upstreams',
        message: 'Broadcast to all upstreams',
      },
      {
        type: 'inject',
        target: `client:${CONFIG.TEST_PATH}`,
        message: 'Direct to specific client',
      },
      {
        type: 'inject',
        target: `upstream:${CONFIG.TEST_PATH}`,
        message: 'Direct to specific upstream',
      },
    ];

    for (const injection of injections) {
      console.log('[MASTER CLIENT] Sending injection:', injection.target);
      this.ws.send(JSON.stringify(injection));
    }
  }

  close() {
    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.close();
      }
      this.ws = null;
    }
  }
}

// Test client implementation
class TestClient {
  constructor(port, path) {
    this.port = port;
    this.path = path;
    this.ws = null;
  }

  connect() {
    this.ws = new WebSocket(`ws://localhost:${this.port}${this.path}`);

    this.ws.on('open', async () => {
      console.log('[TEST CLIENT] Connected to multiplexer');

      // Send a test message
      await wait(300);
      console.log('[TEST CLIENT] Sending message to server');
      this.ws.send('Hello from client');
    });

    this.ws.on('message', (message) => {
      const messageStr = message.toString();
      console.log(`[TEST CLIENT] Received message: ${messageStr}`);
      testResults.clientReceivedMessages.push(messageStr);

      // Check if we received the injected message from master
      if (messageStr === 'Injected message from master') {
        console.log('[TEST CLIENT] Received injected message from master!');
        testResults.masterInjectionReceived = true;
      }
    });

    this.ws.on('error', (error) => {
      console.error('[TEST CLIENT] Error:', error);
    });

    this.ws.on('close', (code, reason) => {
      console.log(`[TEST CLIENT] Connection closed: ${code} ${reason}`);
    });
  }

  close() {
    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.close();
      }
      this.ws = null;
    }
  }
}

// Add timeout utility
function withTimeout(promise, ms, errorMessage) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(errorMessage || `Operation timed out after ${ms}ms`)
          ),
        ms
      )
    ),
  ]);
}

// WebSocket client for testing
class WebSocketClient {
  constructor(url, headers = {}) {
    this.url = url;
    this.messageQueue = [];
    this.ws = null;
    this.headers = headers;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url, { headers: this.headers });

      this.ws.on('open', () => {
        console.log(`[WebSocketClient] Connected to ${this.url}`);
        resolve();
      });

      this.ws.on('error', (error) => {
        console.error(`[WebSocketClient] Error on ${this.url}:`, error);
        reject(error);
      });

      this.ws.on('message', (message) => {
        console.log(
          `[WebSocketClient] Received on ${this.url}:`,
          message.toString()
        );
        this.messageQueue.push(message.toString());
        console.debug(
          `[WebSocketClient] Message queue for ${this.url}:`,
          this.messageQueue
        );
      });

      this.ws.on('close', (code, reason) => {
        console.log(
          `[WebSocketClient] Connection closed on ${this.url}:`,
          code,
          reason.toString()
        );
      });
    });
  }

  async receiveMessage(timeoutMs = 2000) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      console.debug(
        `[WebSocketClient] Receiving message from ${this.url}`,
        this.messageQueue
      );
      if (this.messageQueue.length > 0) {
        return this.messageQueue.shift();
      }
      await wait(100);
    }
    throw new Error(
      `Timeout waiting for message on ${this.url} after ${timeoutMs}ms`
    );
  }

  send(message) {
    return new Promise((resolve, reject) => {
      this.ws.send(message, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  close() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
  }
}

// Test runner
class TestRunner {
  constructor(config) {
    this.config = config;
    this.upstream = new TestServer(config.TEST_PORT);
    this.multiplexer = new MultiplexerProcess(config);

    // Create different types of master connections
    this.masterControl = new MasterClient(config.MASTER_PORT, '/');
    this.masterClientMonitor = new MasterClient(
      config.MASTER_PORT,
      `/client${config.TEST_PATH}`
    );
    this.masterUpstreamMonitor = new MasterClient(
      config.MASTER_PORT,
      `/upstream${config.TEST_PATH}`
    );

    this.testClient = new TestClient(config.PROXY_PORT, config.TEST_PATH);
  }

  async setup() {
    // Kill any existing processes on the ports we'll use
    await Promise.all([
      killProcessOnPort(this.config.TEST_PORT),
      killProcessOnPort(this.config.PROXY_PORT),
      killProcessOnPort(this.config.MASTER_PORT),
    ]);

    await this.upstream.start();
    await this.multiplexer.start();
    await wait(500);
  }


  async runTests() {
    console.log('\nRunning WebSocket Multiplexer Tests...\n');

    const testHeaders = { authorization: 'TestTestTest' };

    // Setup clients
    const client = new WebSocketClient(
      `ws://localhost:${this.config.PROXY_PORT}${this.config.TEST_PATH}`,
      testHeaders
    );
    const masterControl = new WebSocketClient(
      `ws://localhost:${this.config.MASTER_PORT}/`
    );
    const masterClientMonitor = new WebSocketClient(
      `ws://localhost:${this.config.MASTER_PORT}/client${this.config.TEST_PATH}`
    );
    const masterUpstreamMonitor = new WebSocketClient(
      `ws://localhost:${this.config.MASTER_PORT}/upstream${this.config.TEST_PATH}`
    );

    await Promise.all([
      client.connect(),
      masterControl.connect(),
      masterClientMonitor.connect(),
      masterUpstreamMonitor.connect(),
    ]);

    // Test 1: Client to upstream communication
    console.log('Test: Client to upstream communication');
    const clientMsg = randomMessage('client->upstream');

    // First consume the initial status message from master
    const statusMsg = await masterControl.receiveMessage();
    const statusData = JSON.parse(statusMsg);
    assert.equal(statusData.type, 'status');
    assert.deepEqual(statusData.clients, [CONFIG.TEST_PATH]);
    assert.deepEqual(statusData.upstreams, [CONFIG.TEST_PATH]);

    await client.send(clientMsg);
    assert.equal(await this.upstream.receiveMessage(), clientMsg);
    assert.equal(await masterUpstreamMonitor.receiveMessage(), clientMsg);

    console.log('Test: Header forwarding');
    assert.equal(this.upstream.lastRequestHeaders.authorization, testHeaders.authorization);

    // Consume the client-to-upstream message notification
    const clientToUpstreamMsg = await masterControl.receiveMessage();
    const clientToUpstreamData = JSON.parse(clientToUpstreamMsg);
    assert.equal(clientToUpstreamData.type, 'message');
    assert.equal(clientToUpstreamData.direction, 'client-to-upstream');
    assert.equal(clientToUpstreamData.message, clientMsg);

    // Test 2: Upstream to client communication
    console.log('Test: Upstream to client communication');
    this.upstream.send(clientMsg, this.config.TEST_PATH);
    const echoMsg = await client.receiveMessage();
    assert.equal(echoMsg, clientMsg);
    assert.equal(await masterClientMonitor.receiveMessage(), echoMsg);

    // Consume the upstream-to-client message notification
    const upstreamToClientMsg = await masterControl.receiveMessage();
    const upstreamToClientData = JSON.parse(upstreamToClientMsg);
    assert.equal(upstreamToClientData.type, 'message');
    assert.equal(upstreamToClientData.direction, 'upstream-to-client');
    assert.equal(upstreamToClientData.message, clientMsg);

    // Test 3: Master injection to all clients
    console.log('Test: Master injection to all clients');
    const broadcastMsg = randomMessage('master->all-clients');
    await masterControl.send(
      JSON.stringify({
        type: 'inject',
        target: 'all-clients',
        message: broadcastMsg,
      })
    );
    assert.equal(await client.receiveMessage(), broadcastMsg);

    // Test 4: Master injection to specific client
    console.log('Test: Master injection to specific client');
    const directMsg = randomMessage('master->specific-client');
    await masterControl.send(
      JSON.stringify({
        type: 'inject',
        target: `client:${this.config.TEST_PATH}`,
        message: directMsg,
      })
    );
    assert.equal(await client.receiveMessage(), directMsg);

    // Test 5: Master injection to upstream
    console.log('Test: Master injection to upstream');
    const upstreamMsg = randomMessage('master->upstream');
    await masterControl.send(
      JSON.stringify({
        type: 'inject',
        target: `upstream:${this.config.TEST_PATH}`,
        message: upstreamMsg,
      })
    );
    assert.equal(await this.upstream.receiveMessage(), upstreamMsg);

    // Test 6: Monitor injection
    console.log('Test: Monitor injection');
    const monitorMsg = randomMessage('monitor->client');
    await masterClientMonitor.send(monitorMsg);
    assert.equal(await client.receiveMessage(), monitorMsg);

    // Test 7: Client disconnection notification
    console.log('Test: Client disconnection notification');
    client.close();
    const disconnectMsg = await masterControl.receiveMessage();
    const disconnectData = JSON.parse(disconnectMsg);
    assert.equal(disconnectData.type, 'connection');
    assert.equal(disconnectData.event, 'client-disconnected');
    assert.equal(disconnectData.connectionId, CONFIG.TEST_PATH);

    // Cleanup
    masterControl.close();
    masterClientMonitor.close();
    masterUpstreamMonitor.close();

    console.log('\n🎉🎉🎉 All tests passed! 🎉🎉🎉\n');
  }

  async cleanup() {
    this.multiplexer.stop();
    this.upstream.stop();

    // Wait for processes to terminate
    return new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

/**
 * Main function to run all tests
 */
async function runTests() {
  const testRunner = new TestRunner(CONFIG);
  globalTestRunner = testRunner;
  process.exitCode = 0;

  console.log('Starting test runner setup...');
  try {
    await withTimeout(testRunner.setup(), 5000, 'Test setup timed out');
    console.log('Test setup completed. Starting tests...');

    await testRunner.runTests();
    console.log('\nTests completed successfully.');
  } catch (error) {
    console.error('\nTEST FAILURE:', error);
    process.exitCode = 1;
  } finally {
    console.log('Cleaning up...');
    try {
      await testRunner.cleanup();
      console.log('Cleanup completed.');
    } catch (cleanupError) {
      console.error('Error during cleanup:', cleanupError);
      process.exitCode = 2;
    }
    globalTestRunner = null;
    process.exit(process.exitCode);
  }
}

// Start the tests
runTests();

// Handle process termination signals
process.on('SIGINT', async () => {
  console.log('Received SIGINT, cleaning up...');
  if (globalTestRunner) {
    try {
      await globalTestRunner.cleanup();
      console.log('Cleanup completed after SIGINT.');
    } catch (error) {
      console.error('Error during cleanup after SIGINT:', error);
    }
    globalTestRunner = null;
  }
  process.exit(1);
});

process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, cleaning up...');
  if (globalTestRunner) {
    try {
      await globalTestRunner.cleanup();
      console.log('Cleanup completed after SIGTERM.');
    } catch (error) {
      console.error('Error during cleanup after SIGTERM:', error);
    }
    globalTestRunner = null;
  }
  process.exit(1);
});
