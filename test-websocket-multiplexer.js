const WebSocket = require('ws');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const assert = require('node:assert');
const { SIGINT } = require('node:constants');

// Dedicated ports: 8080/8081/9000 are commonly taken by local dev stacks (Docker, Keycloak, Hasura...).
const CONFIG = {
  TEST_PORT: 19000,
  PROXY_PORT: 18080,
  MASTER_PORT: 18081,
  TEST_PATH: '/test-connection',
  TIMEOUT_MS: 5000,
};

// Real-looking station credentials: the multiplexer output is checked for any trace of them.
const basicAuth = (user, password) =>
  `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
const STATION_PASSWORD = 'station-secret-password';
const STATION_AUTH = basicAuth('CP001', STATION_PASSWORD);
const FRAME_SECRET = 'frame-secret-authorization-key';

// Global reference to the test runner for cleanup
/** @type {TestRunner} */
let globalTestRunner = null;

// Fail fast on a busy port: killing its holder took down Docker Desktop on a dev machine.
function ensurePortFree(port) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', (error) =>
      reject(new Error(`Test port ${port} is not available: ${error.message}`))
    );
    probe.once('listening', () => probe.close(() => resolve()));
    probe.listen(port);
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
process.on('unhandledRejection', (reason, _promise) => {
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

async function waitFor(predicate, timeoutMs, label) {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    if (predicate()) return;
    await wait(50);
  }
  throw new Error(`Timeout waiting for ${label}`);
}

// Resolves with the HTTP status the multiplexer answers a handshake with (101 when accepted).
function handshakeStatus(url, headers = {}) {
  return withTimeout(
    new Promise((resolve) => {
      const ws = new WebSocket(url, { headers });
      ws.on('error', () => {});
      ws.on('unexpected-response', (_request, response) => {
        resolve(response.statusCode);
        ws.terminate();
      });
      ws.on('open', () => {
        resolve(101);
        ws.close();
      });
    }),
    3000,
    `No handshake answer on ${url}`
  );
}

// Spawns a multiplexer and resolves once it listens.
function startMultiplexer(label, env) {
  const child = spawn('node', ['websocket-multiplex.js'], {
    env: { ...process.env, ...env },
  });
  child.stdout.on('data', (data) => {
    console.log(`[${label}] ${data.toString().trim()}`);
  });
  child.stderr.on('data', (data) => {
    console.error(`[${label} ERROR] ${data.toString().trim()}`);
  });
  return withTimeout(
    new Promise((resolve, reject) => {
      child.stdout.on('data', (data) => {
        if (data.toString().includes('multiplexer running')) resolve(child);
      });
      child.on('exit', (code) =>
        reject(new Error(`${label} exited with code ${code}`))
      );
    }),
    5000,
    `${label} startup timed out`
  );
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
  constructor(port, wsOptions = {}) {
    this.port = port;
    this.server = http.createServer();
    this.wss = new WebSocket.Server({ server: this.server, ...wsOptions });
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

// Multiplexer process manager
class MultiplexerProcess {
  constructor(config) {
    this.config = config;
    this.process = null;
    // Everything the multiplexer wrote, to check that no credential leaks into its logs.
    this.output = '';
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
        this.output += data.toString();
        console.log(`[MULTIPLEXER] ${data.toString().trim()}`);
        if (data.toString().includes('multiplexer running')) {
          resolve();
        }
      });

      this.process.stderr.on('data', (data) => {
        this.output += data.toString();
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
    await Promise.all([
      ensurePortFree(this.config.TEST_PORT),
      ensurePortFree(this.config.PROXY_PORT),
      ensurePortFree(this.config.MASTER_PORT),
    ]);

    await this.upstream.start();
    await this.multiplexer.start();
    await wait(500);
  }

  async runTests() {
    console.log('\nRunning WebSocket Multiplexer Tests...\n');

    const testHeaders = { authorization: STATION_AUTH };

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

    // The initial master status must list the client: register it before the masters connect.
    await client.connect();
    await waitFor(
      () => this.upstream.connections.has(this.config.TEST_PATH),
      2000,
      'the upstream session of the test client'
    );
    await Promise.all([
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
    assert.equal(
      this.upstream.lastRequestHeaders.authorization,
      testHeaders.authorization
    );

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

    // A CSMS setting the station password: forwarded untouched, kept out of the logs.
    console.log('Test: Credential-bearing frame is forwarded');
    const credentialFrame = JSON.stringify([
      2,
      'cfg-1',
      'ChangeConfiguration',
      { key: 'AuthorizationKey', value: FRAME_SECRET },
    ]);
    this.upstream.send(credentialFrame, this.config.TEST_PATH);
    assert.equal(await client.receiveMessage(), credentialFrame);
    assert.equal(await masterClientMonitor.receiveMessage(), credentialFrame);
    const credentialFrameData = JSON.parse(
      await masterControl.receiveMessage()
    );
    assert.equal(credentialFrameData.direction, 'upstream-to-client');
    assert.equal(credentialFrameData.message, credentialFrame);

    // Test 7: Client disconnection notification
    console.log('Test: Client disconnection notification');
    client.close();
    const disconnectMsg = await masterControl.receiveMessage();
    const disconnectData = JSON.parse(disconnectMsg);
    assert.equal(disconnectData.type, 'connection');
    assert.equal(disconnectData.event, 'client-disconnected');
    assert.equal(disconnectData.connectionId, CONFIG.TEST_PATH);

    // Test 8: Master connection close functionality
    console.log('Test: Master connection close functionality');

    // Create a new client for the close test
    const clientForClose = new WebSocketClient(
      `ws://localhost:${this.config.PROXY_PORT}${this.config.TEST_PATH}`,
      testHeaders
    );
    await clientForClose.connect();

    // Wait for connection to be established and consume the client-connected notification
    await wait(500);
    const clientConnectedMsg = await masterControl.receiveMessage();
    const clientConnectedData = JSON.parse(clientConnectedMsg);
    assert.equal(clientConnectedData.type, 'connection');
    assert.equal(clientConnectedData.event, 'client-connected');
    assert.equal(
      clientConnectedData.headers.authorization,
      'Basic <redacted>',
      'Masters must only see a masked Authorization header'
    );
    assert(
      !clientConnectedMsg.includes(STATION_AUTH.slice('Basic '.length)),
      'The client-connected notification must not carry the credential'
    );
    assert.equal(
      clientForClose.ws.readyState,
      WebSocket.OPEN,
      'Connection should be open'
    );

    // Send close command via master
    const closeReason = 'Test closure from master';
    await masterControl.send(
      JSON.stringify({
        type: 'close',
        connectionId: this.config.TEST_PATH,
        reason: closeReason,
      })
    );

    // Verify the connection-closed-by-master notification
    const closedByMasterMsg = await masterControl.receiveMessage();
    const closedByMasterData = JSON.parse(closedByMasterMsg);
    assert.equal(closedByMasterData.type, 'connection');
    assert.equal(closedByMasterData.event, 'connection-closed-by-master');
    assert.equal(closedByMasterData.connectionId, CONFIG.TEST_PATH);
    assert.equal(closedByMasterData.reason, closeReason);
    assert(closedByMasterData.timestamp);

    // Try to send a message - it should fail because the connection is closed
    try {
      await clientForClose.send('This should fail');
      assert.fail('Message should not be sent, connection should be closed');
    } catch (error) {
      console.log(
        `Connection properly closed, message send failed as expected: ${error.message}`
      );
    }

    assert.equal(
      clientForClose.ws.readyState,
      WebSocket.CLOSED,
      'Connection should be closed'
    );

    console.log('Test: No station credential in the multiplexer output');
    const output = this.multiplexer.output;
    assert(
      output.includes('Basic <redacted>'),
      'The masked Authorization header should be logged'
    );
    for (const secret of [
      STATION_AUTH.slice('Basic '.length),
      STATION_PASSWORD,
      FRAME_SECRET,
    ]) {
      assert(
        !output.includes(secret),
        `The multiplexer output leaks a credential (${secret.slice(0, 4)}...)`
      );
    }

    // Test 9: Dynamic upstream configuration
    await this.testDynamicUpstream();

    // Test 10: Replaced or superseded connections never leave a ghost upstream
    await this.testConnectionReplacementRaces();

    // Test 11: Upstream refusals reach the station and never evict the connected one
    await this.testUpstreamRefusals();

    // Test 12: The heartbeat frees the path of a silent station and keeps live ones
    await this.testStationHeartbeat();

    // Cleanup
    masterControl.close();
    masterClientMonitor.close();
    masterUpstreamMonitor.close();

    console.log('\n🎉🎉🎉 All tests passed! 🎉🎉🎉\n');
  }

  async testDynamicUpstream() {
    console.log('Test: Dynamic upstream configuration');

    // Create a second upstream server on a different port to prove dynamic routing works
    const DYNAMIC_UPSTREAM_PORT = this.config.TEST_PORT + 100;
    const dynamicUpstream = new TestServer(DYNAMIC_UPSTREAM_PORT);
    await dynamicUpstream.start();

    const headers = { 'Content-Type': 'text/plain' };
    const handlers = {
      '/test-dynamic': (_req, res) =>
        res
          .writeHead(200, headers)
          .end(`ws://localhost:${DYNAMIC_UPSTREAM_PORT}/test-dynamic`),
      '/test-invalid-url': (_req, res) =>
        res.writeHead(200, headers).end('not-a-valid-url'),
      '/test-invalid-protocol': (_req, res) =>
        res.writeHead(200, headers).end('http://localhost:9000/test'),
    };

    // Create a dynamic config server that routes to the alternative upstream
    const configServer = http.createServer((req, res) => {
      const handler = handlers[req.url];
      return handler
        ? handler(req, res)
        : res.writeHead(404, headers).end('Not found');
    });

    const CONFIG_PORT = this.config.TEST_PORT + 999;
    const DYNAMIC_MULTIPLEXER_PORT = this.config.PROXY_PORT + 10;

    await withTimeout(
      new Promise((resolve) => {
        configServer.listen(CONFIG_PORT, () => resolve());
      }),
      2000,
      'Config server startup timed out'
    );

    // Start a multiplexer with dynamic upstream configuration
    const dynamicEnv = {
      ...process.env,
      PORT: DYNAMIC_MULTIPLEXER_PORT.toString(),
      MASTER_PORT: (this.config.MASTER_PORT + 10).toString(),
      UPSTREAM_URL: `ws://localhost:${this.config.TEST_PORT}`, // Default fallback
      DYNAMIC_UPSTREAM_CONFIG_URL: `http://localhost:${CONFIG_PORT}`,
      LOG_LEVEL: 'DEBUG',
    };

    const dynamicMultiplexer = spawn('node', ['websocket-multiplex.js'], {
      env: dynamicEnv,
    });

    // Add error logging for the dynamic multiplexer
    dynamicMultiplexer.stdout.on('data', (data) => {
      console.log(`[DYNAMIC MULTIPLEXER] ${data.toString().trim()}`);
    });

    dynamicMultiplexer.stderr.on('data', (data) => {
      console.error(`[DYNAMIC MULTIPLEXER ERROR] ${data.toString().trim()}`);
    });

    await withTimeout(
      new Promise((resolve, reject) => {
        let resolved = false;
        dynamicMultiplexer.stdout.on('data', (data) => {
          if (!resolved && data.toString().includes('multiplexer running')) {
            resolved = true;
            resolve();
          }
        });
        dynamicMultiplexer.on('error', reject);
        dynamicMultiplexer.on('exit', (code) => {
          if (!resolved)
            reject(new Error(`Dynamic multiplexer exited with code ${code}`));
        });
      }),
      5000,
      'Dynamic multiplexer startup timed out'
    );

    try {
      // Test 1: Dynamic upstream resolution
      const dynamicClient = new WebSocketClient(
        `ws://localhost:${DYNAMIC_MULTIPLEXER_PORT}/test-dynamic`
      );
      await withTimeout(
        dynamicClient.connect(),
        3000,
        'Dynamic client connection timed out'
      );

      // Wait a bit for the upstream connection to be fully established
      await wait(1000);

      const testMsg = randomMessage('dynamic-test');
      await dynamicClient.send(testMsg);

      // Verify message reached the DYNAMIC upstream server (not the original one)
      const receivedMsg = await withTimeout(
        dynamicUpstream.receiveMessage(),
        3000,
        'Waiting for dynamic upstream message timed out'
      );
      assert.equal(receivedMsg, testMsg);

      // Verify the original upstream server did NOT receive the message
      let originalUpstreamReceived = false;
      try {
        await withTimeout(
          this.upstream.receiveMessage(),
          500,
          'Should not receive on original upstream'
        );
      } catch (error) {
        originalUpstreamReceived = error.message.includes('Should not receive');
      }
      assert(
        originalUpstreamReceived,
        'Message should not have reached original upstream'
      );

      dynamicClient.close();
      console.log(
        '✓ Dynamic upstream resolution successful - message routed to correct upstream'
      );

      // Test 2: Fallback behavior for unknown paths
      const fallbackClient = new WebSocketClient(
        `ws://localhost:${DYNAMIC_MULTIPLEXER_PORT}/test-fallback`
      );
      await withTimeout(
        fallbackClient.connect(),
        3000,
        'Fallback client connection timed out'
      );

      // Wait a bit for the upstream connection to be fully established
      await wait(1000);

      const fallbackMsg = randomMessage('fallback-test');
      await fallbackClient.send(fallbackMsg);

      // Should reach the original upstream (fallback) since dynamic config returns 404
      const fallbackReceived = await withTimeout(
        this.upstream.receiveMessage(),
        3000,
        'Waiting for fallback message timed out'
      );
      assert.equal(fallbackReceived, fallbackMsg);

      // Verify dynamic upstream did NOT receive the fallback message
      let dynamicUpstreamReceived = false;
      try {
        await withTimeout(
          dynamicUpstream.receiveMessage(),
          500,
          'Should not receive on dynamic upstream'
        );
      } catch (error) {
        dynamicUpstreamReceived = error.message.includes('Should not receive');
      }
      assert(
        dynamicUpstreamReceived,
        'Fallback message should not have reached dynamic upstream'
      );

      fallbackClient.close();
      console.log(
        '✓ Dynamic upstream fallback successful - message routed to default upstream'
      );

      // Test 3: Invalid URL validation - should fall back to default
      const invalidUrlClient = new WebSocketClient(
        `ws://localhost:${DYNAMIC_MULTIPLEXER_PORT}/test-invalid-url`
      );
      await withTimeout(
        invalidUrlClient.connect(),
        3000,
        'Invalid URL client connection timed out'
      );

      // Wait a bit for the upstream connection to be fully established
      await wait(1000);

      const invalidUrlMsg = randomMessage('invalid-url-test');
      await invalidUrlClient.send(invalidUrlMsg);

      // Should reach the original upstream (fallback) since invalid URL is returned
      const invalidUrlReceived = await withTimeout(
        this.upstream.receiveMessage(),
        3000,
        'Waiting for invalid URL message timed out'
      );
      assert.equal(invalidUrlReceived, invalidUrlMsg);

      invalidUrlClient.close();
      console.log(
        '✓ Invalid URL validation successful - falls back to default upstream'
      );

      // Test 4: Invalid protocol validation - should fall back to default
      const invalidProtocolClient = new WebSocketClient(
        `ws://localhost:${DYNAMIC_MULTIPLEXER_PORT}/test-invalid-protocol`
      );
      await withTimeout(
        invalidProtocolClient.connect(),
        3000,
        'Invalid protocol client connection timed out'
      );

      // Wait a bit for the upstream connection to be fully established
      await wait(1000);

      const invalidProtocolMsg = randomMessage('invalid-protocol-test');
      await invalidProtocolClient.send(invalidProtocolMsg);

      // Should reach the original upstream (fallback) since invalid protocol is returned
      const invalidProtocolReceived = await withTimeout(
        this.upstream.receiveMessage(),
        3000,
        'Waiting for invalid protocol message timed out'
      );
      assert.equal(invalidProtocolReceived, invalidProtocolMsg);

      invalidProtocolClient.close();
      console.log(
        '✓ Invalid protocol validation successful - falls back to default upstream'
      );
    } finally {
      if (dynamicMultiplexer && !dynamicMultiplexer.killed) {
        dynamicMultiplexer.kill('SIGKILL');
      }
      configServer.close();
      dynamicUpstream.stop();
      await wait(500);
    }
  }

  async testConnectionReplacementRaces() {
    console.log('Test: Connection replacement races leave no ghost upstream');

    const RACE_UPSTREAM_PORT = this.config.TEST_PORT + 200;
    const RACE_CONFIG_PORT = this.config.TEST_PORT + 201;
    const RACE_PROXY_PORT = this.config.PROXY_PORT + 20;
    const RACE_MASTER_PORT = this.config.MASTER_PORT + 20;
    const SLOW_RESOLUTION_MS = 600;

    const raceUpstream = new TestServer(RACE_UPSTREAM_PORT);
    /** @type {Map<WebSocket, { path: string, socket: net.Socket }>} */
    const upstreamSessions = new Map();
    raceUpstream.wss.on('connection', (ws, req) => {
      upstreamSessions.set(ws, { path: req.url, socket: req.socket });
    });
    await raceUpstream.start();
    const everOpenedOn = (path) =>
      [...upstreamSessions.values()].filter((s) => s.path === path).length;
    const liveSessionsOn = (path) =>
      [...upstreamSessions.entries()]
        .filter(
          ([ws, s]) => s.path === path && ws.readyState !== WebSocket.CLOSED
        )
        .map(([ws]) => ws);
    const openSessionsOn = (path) =>
      liveSessionsOn(path).filter((ws) => ws.readyState === WebSocket.OPEN)
        .length;

    // Paths starting with /slow- resolve late, opening the window the races need.
    const configServer = http.createServer((req, res) => {
      const delay = req.url.startsWith('/slow-') ? SLOW_RESOLUTION_MS : 0;
      setTimeout(
        () =>
          res
            .writeHead(200, { 'Content-Type': 'text/plain' })
            .end(`ws://localhost:${RACE_UPSTREAM_PORT}${req.url}`),
        delay
      );
    });
    await new Promise((resolve) =>
      configServer.listen(RACE_CONFIG_PORT, () => resolve())
    );

    const raceMultiplexer = spawn('node', ['websocket-multiplex.js'], {
      env: {
        ...process.env,
        PORT: RACE_PROXY_PORT.toString(),
        MASTER_PORT: RACE_MASTER_PORT.toString(),
        UPSTREAM_URL: `ws://localhost:${RACE_UPSTREAM_PORT}`,
        DYNAMIC_UPSTREAM_CONFIG_URL: `http://localhost:${RACE_CONFIG_PORT}`,
        LOG_LEVEL: 'DEBUG',
      },
    });
    raceMultiplexer.stdout.on('data', (data) => {
      console.log(`[RACE MULTIPLEXER] ${data.toString().trim()}`);
    });
    raceMultiplexer.stderr.on('data', (data) => {
      console.error(`[RACE MULTIPLEXER ERROR] ${data.toString().trim()}`);
    });
    await withTimeout(
      new Promise((resolve) => {
        raceMultiplexer.stdout.on('data', (data) => {
          if (data.toString().includes('multiplexer running')) resolve();
        });
      }),
      5000,
      'Race multiplexer startup timed out'
    );
    const proxyUrl = (path) => `ws://localhost:${RACE_PROXY_PORT}${path}`;

    try {
      // Race 1: the replaced upstream finishes closing only after its successor registered (CSMS round trip).
      const replacedPath = '/replaced';
      const first = new WebSocketClient(proxyUrl(replacedPath));
      await first.connect();
      await waitFor(
        () => openSessionsOn(replacedPath) === 1,
        2000,
        'the first upstream session'
      );
      const oldSession = liveSessionsOn(replacedPath)[0];
      upstreamSessions.get(oldSession).socket.pause();

      const second = new WebSocketClient(proxyUrl(replacedPath));
      await second.connect();
      await waitFor(
        () => liveSessionsOn(replacedPath).length === 2,
        2000,
        'the replacement upstream session'
      );
      upstreamSessions.get(oldSession).socket.resume();
      await waitFor(
        () => oldSession.readyState === WebSocket.CLOSED,
        2000,
        'the replaced upstream session to close'
      );
      await wait(300);

      assert.equal(
        second.ws.readyState,
        WebSocket.OPEN,
        'The late close of the replaced upstream must not close the new client'
      );
      const replacedMsg = randomMessage('after-replacement');
      await second.send(replacedMsg);
      assert.equal(await raceUpstream.receiveMessage(2000), replacedMsg);
      second.close();
      await waitFor(
        () => openSessionsOn(replacedPath) === 0,
        2000,
        'no upstream left open after the client left'
      );
      console.log(
        '✓ Late close of a replaced upstream keeps the new connection and leaves no ghost'
      );

      // Race 2: the client leaves while its handshake is held for upstream resolution.
      const leftPath = '/slow-left';
      const leaver = new WebSocket(proxyUrl(leftPath));
      leaver.on('error', () => {});
      await wait(100);
      leaver.terminate();
      await wait(SLOW_RESOLUTION_MS + 700);
      assert.equal(
        everOpenedOn(leftPath),
        0,
        'No upstream may be opened for a client that already left'
      );
      console.log(
        '✓ No upstream opened for a client that left during resolution'
      );

      // Race 3: a second connection arrives while the first one is still being resolved.
      const concurrentPath = '/slow-concurrent';
      const older = new WebSocketClient(proxyUrl(concurrentPath));
      // The older handshake is either accepted then replaced, or refused if the newer one won upstream.
      const olderSettled = older.connect().catch(() => {});
      await wait(100);
      const newer = new WebSocketClient(proxyUrl(concurrentPath));
      await newer.connect();
      await olderSettled;
      await waitFor(
        () =>
          older.ws.readyState !== WebSocket.OPEN &&
          openSessionsOn(concurrentPath) === 1,
        2000,
        'the older connection to give way'
      );
      await wait(300);
      assert.equal(
        openSessionsOn(concurrentPath),
        1,
        'Only the newest connection may keep an upstream session'
      );
      assert.equal(newer.ws.readyState, WebSocket.OPEN);
      assert.notEqual(older.ws.readyState, WebSocket.OPEN);
      const concurrentMsg = randomMessage('newest-wins');
      await newer.send(concurrentMsg);
      assert.equal(await raceUpstream.receiveMessage(2000), concurrentMsg);
      newer.close();
      await waitFor(
        () => openSessionsOn(concurrentPath) === 0,
        2000,
        'no upstream left open after the newest client left'
      );
      console.log(
        '✓ Concurrent connections on one path keep a single upstream'
      );
    } finally {
      raceMultiplexer.kill('SIGKILL');
      configServer.close();
      raceUpstream.stop();
      await wait(500);
    }
  }

  async testUpstreamRefusals() {
    console.log(
      'Test: Upstream refusals reach the newcomer and never evict the connected station'
    );

    const AUTH_UPSTREAM_PORT = this.config.TEST_PORT + 300;
    const AUTH_PROXY_PORT = this.config.PROXY_PORT + 30;
    const AUTH_MASTER_PORT = this.config.MASTER_PORT + 30;
    const stationPath = '/CP-AUTH';
    const stationAuth = basicAuth('CP-AUTH', 'right-password');
    const rotatedAuth = basicAuth('CP-AUTH', 'rotated-password');
    const acceptedAuths = new Set([stationAuth, rotatedAuth]);
    const anonymousPath = '/open-CP-ANON';

    /** @type {Map<WebSocket, string>} */
    const upstreamSessions = new Map();
    const openSessionsOn = (path) =>
      [...upstreamSessions.entries()].filter(
        ([ws, sessionPath]) =>
          sessionPath === path && ws.readyState === WebSocket.OPEN
      ).length;

    // Plays the CSMS: unknown stations get a 404, forbidden ones a 403, wrong or missing credentials a 401.
    const authUpstream = new TestServer(AUTH_UPSTREAM_PORT, {
      verifyClient: (info, done) => {
        if (info.req.url.startsWith('/unknown')) return done(false, 404);
        if (info.req.url.startsWith('/forbidden')) return done(false, 403);
        if (info.req.url.startsWith('/unavailable')) return done(false, 503);
        // Stations without Basic auth (security profile 0): accepted, but a duplicate identity is refused.
        if (info.req.url.startsWith('/open')) {
          if (openSessionsOn(info.req.url) > 0) return done(false, 409);
          return done(true);
        }
        if (!acceptedAuths.has(info.req.headers.authorization)) {
          return done(false, 401);
        }
        done(true);
      },
    });
    authUpstream.wss.on('connection', (ws, req) => {
      upstreamSessions.set(ws, req.url);
    });
    await authUpstream.start();

    // DEBUG on purpose: its unexpected-response listener used to leave refused handshakes hanging.
    const multiplexer = await startMultiplexer('AUTH MULTIPLEXER', {
      PORT: AUTH_PROXY_PORT.toString(),
      MASTER_PORT: AUTH_MASTER_PORT.toString(),
      UPSTREAM_URL: `ws://localhost:${AUTH_UPSTREAM_PORT}`,
      LOG_LEVEL: 'DEBUG',
    });
    const proxyUrl = (path) => `ws://localhost:${AUTH_PROXY_PORT}${path}`;

    try {
      const station = new WebSocketClient(proxyUrl(stationPath), {
        authorization: stationAuth,
      });
      await station.connect();
      await waitFor(
        () => openSessionsOn(stationPath) === 1,
        2000,
        'the station upstream session'
      );

      assert.equal(
        await handshakeStatus(proxyUrl(stationPath), {
          authorization: basicAuth('CP-AUTH', 'guessed-password'),
        }),
        401,
        'An upstream 401 must reach the newcomer'
      );
      assert.equal(
        await handshakeStatus(proxyUrl(stationPath)),
        401,
        'A newcomer without credentials must get the upstream 401'
      );
      // Every upstream 4xx reaches the station as 401: the status must not tell an unknown serial from a wrong password.
      assert.equal(
        await handshakeStatus(proxyUrl('/unknown-station'), {
          authorization: stationAuth,
        }),
        401,
        'An upstream 404 must reach the newcomer as a 401'
      );
      assert.equal(
        await handshakeStatus(proxyUrl('/forbidden-station'), {
          authorization: stationAuth,
        }),
        401,
        'An upstream 403 must reach the newcomer as a 401'
      );
      assert.equal(
        await handshakeStatus(proxyUrl('/unavailable-station'), {
          authorization: stationAuth,
        }),
        503,
        'An upstream 5xx must reach the newcomer unchanged'
      );

      await wait(300);
      assert.equal(
        station.ws.readyState,
        WebSocket.OPEN,
        'A newcomer refused upstream must not evict the connected station'
      );
      assert.equal(openSessionsOn(stationPath), 1);
      const stationMsg = randomMessage('station-still-connected');
      await station.send(stationMsg);
      assert.equal(await authUpstream.receiveMessage(2000), stationMsg);
      const csmsMsg = randomMessage('csms-to-station');
      authUpstream.send(csmsMsg, stationPath);
      assert.equal(await station.receiveMessage(), csmsMsg);
      console.log(
        '✓ Upstream 401/403/404 reach the newcomer as 401, a 5xx unchanged, and the connected station keeps working'
      );

      // A station back from a network drop reconnects with the credentials it was accepted with.
      const reconnected = new WebSocketClient(proxyUrl(stationPath), {
        authorization: stationAuth,
      });
      await reconnected.connect();
      await waitFor(
        () =>
          station.ws.readyState === WebSocket.CLOSED &&
          openSessionsOn(stationPath) === 1,
        2000,
        'the stale connection to be replaced'
      );
      const reconnectedMsg = randomMessage('after-reconnection');
      await reconnected.send(reconnectedMsg);
      assert.equal(await authUpstream.receiveMessage(2000), reconnectedMsg);
      console.log(
        '✓ A station reconnecting with its credentials replaces its stale connection'
      );

      // Different credentials the upstream accepts (rotated password): replaced once the upstream accepted.
      const rotated = new WebSocketClient(proxyUrl(stationPath), {
        authorization: rotatedAuth,
      });
      await rotated.connect();
      await waitFor(
        () =>
          reconnected.ws.readyState === WebSocket.CLOSED &&
          openSessionsOn(stationPath) === 1,
        2000,
        'the connection accepted upstream to replace the previous one'
      );
      const rotatedMsg = randomMessage('after-rotation');
      await rotated.send(rotatedMsg);
      assert.equal(await authUpstream.receiveMessage(2000), rotatedMsg);
      rotated.close();
      console.log(
        '✓ A newcomer accepted upstream replaces the connected station'
      );

      // Two missing Authorization headers are not the same credential: the newcomer waits for the upstream verdict.
      const anonymousStation = new WebSocketClient(proxyUrl(anonymousPath));
      await anonymousStation.connect();
      await waitFor(
        () => openSessionsOn(anonymousPath) === 1,
        2000,
        'the anonymous station upstream session'
      );
      assert.equal(
        await handshakeStatus(proxyUrl(anonymousPath)),
        401,
        'An anonymous newcomer must get the upstream duplicate refusal (409 upstream, 401 to the station)'
      );
      await wait(300);
      assert.equal(
        anonymousStation.ws.readyState,
        WebSocket.OPEN,
        'An anonymous newcomer must not evict a station connected without credentials'
      );
      assert.equal(openSessionsOn(anonymousPath), 1);
      const anonymousMsg = randomMessage('anonymous-station-still-connected');
      await anonymousStation.send(anonymousMsg);
      assert.equal(await authUpstream.receiveMessage(2000), anonymousMsg);
      anonymousStation.close();
      console.log(
        '✓ An anonymous newcomer never evicts a station connected without credentials'
      );
    } finally {
      multiplexer.kill('SIGKILL');
      authUpstream.stop();
      await wait(500);
    }
  }

  async testStationHeartbeat() {
    console.log(
      'Test: The heartbeat terminates a silent station and keeps a live one'
    );

    const HEARTBEAT_UPSTREAM_PORT = this.config.TEST_PORT + 400;
    const HEARTBEAT_PROXY_PORT = this.config.PROXY_PORT + 40;
    const HEARTBEAT_MASTER_PORT = this.config.MASTER_PORT + 40;
    const HEARTBEAT_INTERVAL_MS = 500;
    // Stations without credentials: a newcomer never evicts them, so only the heartbeat frees a dead one's path.
    const deadPath = '/CP-DEAD';
    const livePath = '/CP-LIVE';

    /** @type {Map<WebSocket, string>} */
    const upstreamSessions = new Map();
    const openSessionsOn = (path) =>
      [...upstreamSessions.entries()].filter(
        ([ws, sessionPath]) =>
          sessionPath === path && ws.readyState === WebSocket.OPEN
      ).length;

    // Plays Citrine: an identity that still has an upstream session is refused as a duplicate.
    const heartbeatUpstream = new TestServer(HEARTBEAT_UPSTREAM_PORT, {
      verifyClient: (info, done) => {
        if (openSessionsOn(info.req.url) > 0) return done(false, 401);
        done(true);
      },
    });
    heartbeatUpstream.wss.on('connection', (ws, req) => {
      upstreamSessions.set(ws, req.url);
    });
    await heartbeatUpstream.start();

    const multiplexer = await startMultiplexer('HEARTBEAT MULTIPLEXER', {
      PORT: HEARTBEAT_PROXY_PORT.toString(),
      MASTER_PORT: HEARTBEAT_MASTER_PORT.toString(),
      UPSTREAM_URL: `ws://localhost:${HEARTBEAT_UPSTREAM_PORT}`,
      STATION_HEARTBEAT_INTERVAL_MS: HEARTBEAT_INTERVAL_MS.toString(),
      LOG_LEVEL: 'DEBUG',
    });
    const proxyUrl = (path) => `ws://localhost:${HEARTBEAT_PROXY_PORT}${path}`;
    const master = new WebSocketClient(
      `ws://localhost:${HEARTBEAT_MASTER_PORT}/`
    );

    try {
      await master.connect();

      const live = new WebSocketClient(proxyUrl(livePath));
      await live.connect();
      let livePings = 0;
      live.ws.on('ping', () => {
        livePings++;
      });

      // autoPong off: the station receives the pings but never answers, like the far end of a half-open socket.
      const dead = new WebSocket(proxyUrl(deadPath), { autoPong: false });
      let deadClosedAt = 0;
      dead.on('close', () => {
        deadClosedAt = Date.now();
      });
      await withTimeout(
        new Promise((resolve, reject) => {
          dead.once('open', resolve);
          dead.once('error', reject);
        }),
        3000,
        'The silent station could not connect'
      );
      const deadOpenedAt = Date.now();
      await waitFor(
        () => openSessionsOn(deadPath) === 1 && openSessionsOn(livePath) === 1,
        2000,
        'both upstream sessions'
      );

      await waitFor(
        () => deadClosedAt > 0,
        3 * HEARTBEAT_INTERVAL_MS + 2000,
        'the silent station to be terminated'
      );
      const elapsed = deadClosedAt - deadOpenedAt;
      assert(
        elapsed >= 0.8 * HEARTBEAT_INTERVAL_MS,
        `A station must get a whole interval to answer the ping (terminated after ${elapsed}ms)`
      );
      assert(
        elapsed <= 2 * HEARTBEAT_INTERVAL_MS + 1000,
        `A silent station must be terminated within about two intervals (took ${elapsed}ms)`
      );
      await waitFor(
        () => openSessionsOn(deadPath) === 0,
        2000,
        'the upstream session of the terminated station to close'
      );
      await waitFor(
        () =>
          master.messageQueue.some((raw) => {
            const event = JSON.parse(raw);
            return (
              event.event === 'client-disconnected' &&
              event.connectionId === deadPath
            );
          }),
        2000,
        'the client-disconnected notification of the terminated station'
      );
      assert.equal(
        await handshakeStatus(proxyUrl(deadPath)),
        101,
        'Once its dead socket is terminated, the station must be able to reconnect'
      );
      console.log(
        `✓ A silent station is terminated after ${elapsed}ms, its upstream closed and its path freed`
      );

      await waitFor(
        () => livePings >= 3,
        4 * HEARTBEAT_INTERVAL_MS + 2000,
        'heartbeat pings on the live station'
      );
      assert.equal(
        live.ws.readyState,
        WebSocket.OPEN,
        'A station answering the pings must keep its connection'
      );
      assert.equal(openSessionsOn(livePath), 1);
      const liveMsg = randomMessage('live-after-heartbeats');
      await live.send(liveMsg);
      assert.equal(await heartbeatUpstream.receiveMessage(2000), liveMsg);
      live.close();
      console.log(
        `✓ A station answering the pings keeps its connection (${livePings} pings)`
      );
    } finally {
      master.close();
      multiplexer.kill('SIGKILL');
      heartbeatUpstream.stop();
      await wait(500);
    }
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
