/**
 * WebSocket Multiplexer Master Injection Test Script
 *
 * This script connects to the WebSocket multiplexer's master server and injects
 * messages to specified targets. It can be used to test the multiplexer's message
 * injection functionality.
 *
 * Usage:
 *   node test-ws-injection.js <target>:<message_file_path>
 *
 * Example:
 *   node test-ws-injection.js client:/YOLO:setChargingProfile.json
 *
 * Arguments:
 *   - target: The target to inject the message to. Can be one of:
 *     - client:<client_id> - Inject to a specific client
 *     - upstream:<upstream_id> - Inject to a specific upstream
 *     - all-clients - Inject to all connected clients
 *     - all-upstreams - Inject to all connected upstreams
 *   - message_file_path: Path to a JSON file containing the message to inject
 *
 * Environment Variables:
 *   - MASTER_URL: URL of the master server (default: ws://localhost:8081)
 *   - TIMEOUT: Timeout in milliseconds for the connection (default: 5000)
 *
 * Examples:
 *   - Inject a message to a specific client:
 *     node test-ws-injection.js client:/CP001:message.json
 *
 *   - Inject a message to all clients:
 *     node test-ws-injection.js all-clients:message.json
 *
 *   - Inject a message to all upstreams:
 *     node test-ws-injection.js all-upstreams:message.json
 *
 *   - Using a custom master URL:
 *     MASTER_URL=ws://example.com:8081 node test-ws-injection.js client:/CP001:message.json
 *
 * Message File Format:
 *   The message file should contain valid JSON that will be sent as-is to the target.
 *   For OCPP messages, this would typically be an array in the format [messageTypeId, messageId, action, payload].
 */

const WebSocket = require('ws');
const fs = require('node:fs');
const path = require('node:path');

// Configuration
const MASTER_URL = process.env.MASTER_URL || 'ws://localhost:8081';
const TIMEOUT = Number.parseInt(process.env.TIMEOUT || '5000', 10);

// Parse command line arguments
function parseArgs() {
  if (process.argv.length !== 3) {
    console.error('Error: Invalid number of arguments');
    console.error(
      'Usage: node test-ws-injection.js <target>:<message_file_path>'
    );
    process.exit(1);
  }

  const arg = process.argv[2];
  const parts = arg.split(':');

  if (parts.length < 2) {
    console.error('Error: Invalid argument format');
    console.error(
      'Usage: node test-ws-injection.js <target>:<message_file_path>'
    );
    process.exit(1);
  }

  // Handle the case where the target might contain colons (e.g., client:/path:file.json)
  const filePath = parts.pop();
  const target = parts.join(':');

  // Validate target
  const validTargets = ['all-clients', 'all-upstreams'];
  const validPrefixes = ['client:', 'upstream:'];

  const isValidTarget =
    validTargets.includes(target) ||
    validPrefixes.some((prefix) => target.startsWith(prefix));

  if (!isValidTarget) {
    console.error('Error: Invalid target');
    console.error(
      'Valid targets: client:<id>, upstream:<id>, all-clients, all-upstreams'
    );
    process.exit(1);
  }

  return { target, filePath };
}

// Read message from file
function readMessageFile(filePath) {
  try {
    const resolvedPath = path.resolve(filePath);
    console.log(`Reading message from: ${resolvedPath}`);

    return fs.readFileSync(resolvedPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.error(`Error: File not found: ${filePath}`);
    } else if (error instanceof SyntaxError) {
      console.error(`Error: Invalid JSON in file: ${filePath}`);
      console.error(error.message);
    } else {
      console.error(`Error reading file: ${error.message}`);
    }
    process.exit(1);
  }
}

// Connect to master server and inject message
function injectMessage(target, message) {
  console.log(`Connecting to master server at ${MASTER_URL}`);

  const ws = new WebSocket(MASTER_URL);
  let connectionClosed = false;

  // Set connection timeout
  const timeoutId = setTimeout(() => {
    if (!connectionClosed) {
      console.error(`Connection timeout after ${TIMEOUT}ms`);
      ws.close();
      process.exit(1);
    }
  }, TIMEOUT);

  ws.on('open', () => {
    console.log('Connected to master server');

    // Create injection message
    const injectionMessage = {
      type: 'inject',
      target,
      message,
    };

    console.log(`Injecting message to target: ${target}`);
    console.log('Message payload:', message);

    // Send the injection message
    ws.send(JSON.stringify(injectionMessage));

    // Wait a bit before closing to ensure message is processed
    setTimeout(() => {
      console.log('Message sent successfully');
      ws.close(1000, 'Injection complete');
    }, 500);
  });

  ws.on('message', (data) => {
    try {
      const response = JSON.parse(data);
      console.log(
        'Received response from master server:',
        JSON.stringify(response, null, 2)
      );
    } catch (error) {
      console.log('Received non-JSON response:', data.toString());
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error.message);
    clearTimeout(timeoutId);
    process.exit(1);
  });

  ws.on('close', (code, reason) => {
    connectionClosed = true;
    clearTimeout(timeoutId);

    const reasonStr = reason ? reason.toString() : 'No reason provided';
    console.log(`Connection closed. Code: ${code}, Reason: ${reasonStr}`);
    process.exit(0);
  });
}

// Main function
function main() {
  try {
    const { target, filePath } = parseArgs();
    const message = readMessageFile(filePath);
    injectMessage(target, message);
  } catch (error) {
    console.error('Unexpected error:', error);
    process.exit(1);
  }
}

// Handle process termination
process.on('SIGINT', () => {
  console.log('Process interrupted');
  process.exit(0);
});

// Start the script
main();
