const WebSocket = require('ws');
const http = require('node:http');
const { spawn } = require('node:child_process');
const assert = require('node:assert');

// Configuration
const CONFIG = {
  TEST_PORT: 9000,
  PROXY_PORT: 8080,
  MASTER_PORT: 8081,
  TEST_PATH: '/test-connection',
  TIMEOUT_MS: 5000,
};

// Helper functions
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Test results tracking
const testResults = {
  serverReceivedMessages: [],
  clientReceivedMessages: [],
  masterReceivedMessages: [],
  masterInjectionReceived: false,
  allTestsPassed: false,
};

// Test server implementation
class TestServer {
  constructor(port) {
    this.port = port;
    this.server = http.createServer();
    this.wss = new WebSocket.Server({ server: this.server });
    this.setupEventHandlers();
  }

  setupEventHandlers() {
    this.wss.on('connection', async (ws, req) => {
      console.log(`[TEST SERVER] Client connected on path: ${req.url}`);

      ws.on('message', async (message) => {
        const messageStr = message.toString();
        console.log(`[TEST SERVER] Received message: ${messageStr}`);
        testResults.serverReceivedMessages.push(messageStr);

        // Echo the message back with a prefix
        ws.send(`ECHO: ${messageStr}`);

        // Check if we've received the expected client message
        if (messageStr === 'Hello from client') {
          await wait(100);
          if (
            testResults.clientReceivedMessages.includes(
              'ECHO: Hello from client'
            ) &&
            testResults.masterInjectionReceived
          ) {
            console.log('[TEST SERVER] All tests passed!');
            if (this.onTestsCompleted) {
              this.onTestsCompleted();
            }
          }
        }
      });

      // Send a message to the client
      await wait(100);
      ws.send('Hello from server');
    });
  }

  start(onStarted) {
    this.server.listen(this.port, () => {
      console.log(
        `[TEST SERVER] WebSocket test server running on port ${this.port}`
      );
      if (onStarted) onStarted();
    });
  }

  stop() {
    this.server.close();
  }

  setTestCompletionCallback(callback) {
    this.onTestsCompleted = callback;
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
      LOG_LEVEL: 'INFO',
    };

    this.process = spawn('node', ['websocket-multiplex.js'], { env });

    this.process.stdout.on('data', (data) => {
      console.log(`[MULTIPLEXER] ${data.toString().trim()}`);
    });

    this.process.stderr.on('data', (data) => {
      console.error(`[MULTIPLEXER ERROR] ${data.toString().trim()}`);
    });

    // Clean up the multiplexer process when tests are done
    process.on('exit', () => {
      this.stop();
    });
  }

  stop() {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
  }
}

// Master client implementation
class MasterClient {
  constructor(port) {
    this.port = port;
    this.ws = null;
  }

  connect() {
    this.ws = new WebSocket(`ws://localhost:${this.port}`);

    this.ws.on('open', () => {
      console.log('[MASTER CLIENT] Connected to multiplexer master port');
    });

    this.ws.on('message', async (message) => {
      const data = JSON.parse(message.toString());
      console.log('[MASTER CLIENT] Received message:', data.type);
      testResults.masterReceivedMessages.push(data);

      // After receiving status, test injection
      if (data.type === 'status') {
        await wait(200);
        this.injectMessage();
      }
    });

    this.ws.on('error', (error) => {
      console.error('[MASTER CLIENT] Error:', error);
    });

    this.ws.on('close', (code, reason) => {
      console.log(`[MASTER CLIENT] Connection closed: ${code} ${reason}`);
    });
  }

  injectMessage() {
    const injectionMessage = {
      type: 'inject',
      target: `client:${CONFIG.TEST_PATH}`,
      message: 'Injected message from master',
    };
    console.log('[MASTER CLIENT] Sending injection message');
    this.ws.send(JSON.stringify(injectionMessage));
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
}

// Test runner
class TestRunner {
  constructor(config) {
    this.config = config;
    this.testServer = new TestServer(config.TEST_PORT);
    this.multiplexer = new MultiplexerProcess(config);
    this.masterClient = new MasterClient(config.MASTER_PORT);
    this.testClient = new TestClient(config.PROXY_PORT, config.TEST_PATH);
    this.testsCompleted = new Promise((resolve) => {
      this.testServer.setTestCompletionCallback(resolve);
    });
  }

  async start() {
    // Start test server
    this.testServer.start(async () => {
      // Start multiplexer
      this.multiplexer.start();

      // Wait for multiplexer to initialize
      await wait(300);

      // Connect master and client
      this.masterClient.connect();
      this.testClient.connect();
    });
  }

  async waitForCompletion() {
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error('Tests timed out')),
        this.config.TIMEOUT_MS
      )
    );

    await Promise.race([this.testsCompleted, timeoutPromise]);
  }

  verifyResults() {
    console.log('\n--- TEST RESULTS ---');

    // Check client received server message
    assert.ok(
      testResults.clientReceivedMessages.includes('Hello from server'),
      'Client should receive message from server'
    );
    console.log('✓ Client received message from server');

    // Check server received client message
    assert.ok(
      testResults.serverReceivedMessages.includes('Hello from client'),
      'Server should receive message from client'
    );
    console.log('✓ Server received message from client');

    // Check client received echo from server
    assert.ok(
      testResults.clientReceivedMessages.includes('ECHO: Hello from client'),
      'Client should receive echo from server'
    );
    console.log('✓ Client received echo from server');

    // Check master injection
    assert.ok(
      testResults.masterInjectionReceived,
      'Client should receive injected message from master'
    );
    console.log('✓ Client received injected message from master');

    // Check master received notifications
    assert.ok(
      testResults.masterReceivedMessages.some((msg) => msg.type === 'status'),
      'Master should receive status message'
    );
    console.log('✓ Master received status message');

    assert.ok(
      testResults.masterReceivedMessages.some(
        (msg) =>
          msg.type === 'message' && msg.direction === 'client-to-upstream'
      ),
      'Master should receive client-to-upstream message notification'
    );
    console.log('✓ Master received client-to-upstream message notification');

    assert.ok(
      testResults.masterReceivedMessages.some(
        (msg) =>
          msg.type === 'message' && msg.direction === 'upstream-to-client'
      ),
      'Master should receive upstream-to-client message notification'
    );
    console.log('✓ Master received upstream-to-client message notification');

    console.log('\nALL TESTS PASSED! 🎉');
  }

  cleanup() {
    this.testServer.stop();
    this.multiplexer.stop();
  }
}

// Main function to run tests
async function runTests() {
  const testRunner = new TestRunner(CONFIG);

  try {
    await testRunner.start();
    await testRunner.waitForCompletion();
    testRunner.verifyResults();
  } catch (error) {
    console.error('\nTEST FAILURE:', error);
    process.exit(1);
  } finally {
    testRunner.cleanup();
    process.exit(0);
  }
}

// Start the tests
runTests();
