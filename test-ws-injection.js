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
const util = require('node:util');

// Configuration
const MASTER_URL = process.env.MASTER_URL || 'ws://localhost:8081';
const TIMEOUT = Number.parseInt(process.env.TIMEOUT || '1000', 10);

const BANNER = `
╔═════════════════════════════════════════════════════╗
║ 💉 WebSocket Multiplexer Message Injector           ║
╚═════════════════════════════════════════════════════╝
`;

// Format JSON with colors
function formatMessage(message) {
  if (typeof message === 'string') {
    try {
      return util.inspect(JSON.parse(message), {
        colors: true,
        depth: null,
        compact: false,
        breakLength: 80,
      });
    } catch (_e) {
      return message;
    }
  }
  return util.inspect(message, {
    colors: true,
    depth: null,
    compact: false,
    breakLength: 80,
  });
}

function isOcppMessage(message) {
  try {
    const parsed = typeof message === 'string' ? JSON.parse(message) : message;
    if (!Array.isArray(parsed) || parsed.length < 3) return false;

    const [messageType, messageId, ...rest] = parsed;
    if (typeof messageType !== 'number' || typeof messageId !== 'string')
      return false;

    if (messageType === 2) {
      // Request
      return (
        rest.length >= 2 &&
        typeof rest[0] === 'string' &&
        typeof rest[1] === 'object'
      );
    }
    if (messageType === 3) {
      // Response
      return rest.length >= 1 && typeof rest[0] === 'object';
    }

    return false;
  } catch (_e) {
    return false;
  }
}

function parseMessage(message) {
  try {
    return typeof message === 'string' ? JSON.parse(message) : message;
  } catch (_e) {
    return null;
  }
}

function getOcppMessageType(parsedMessage) {
  return Array.isArray(parsedMessage) && parsedMessage.length > 0
    ? parsedMessage[0]
    : null;
}

function getOcppMessageId(parsedMessage) {
  return Array.isArray(parsedMessage) && parsedMessage.length > 1
    ? parsedMessage[1]
    : null;
}

function isOcppRequest(parsedMessage) {
  return getOcppMessageType(parsedMessage) === 2;
}

function isOcppResponse(parsedMessage) {
  return getOcppMessageType(parsedMessage) === 3;
}

function getOcppRequestAction(parsedMessage) {
  return isOcppRequest(parsedMessage) && parsedMessage.length > 2
    ? parsedMessage[2]
    : null;
}

function getOcppRequestPayload(parsedMessage) {
  return isOcppRequest(parsedMessage) && parsedMessage.length > 3
    ? parsedMessage[3]
    : null;
}

function getOcppResponsePayload(parsedMessage) {
  return isOcppResponse(parsedMessage) && parsedMessage.length > 2
    ? parsedMessage[2]
    : null;
}

function isMatchingOcppResponse(requestId, message) {
  const parsedMessage = parseMessage(message);
  if (!parsedMessage) return false;

  return (
    isOcppResponse(parsedMessage) &&
    getOcppMessageId(parsedMessage) === requestId
  );
}

function formatOcppMessage(message) {
  const parsedMessage = parseMessage(message);
  if (!parsedMessage) return null;

  const messageType = getOcppMessageType(parsedMessage);
  const messageId = getOcppMessageId(parsedMessage);

  if (messageType === 2) {
    const action = getOcppRequestAction(parsedMessage);
    const payload = getOcppRequestPayload(parsedMessage);
    return {
      type: 'request',
      messageId,
      action,
      payload,
    };
  }

  if (messageType === 3) {
    const payload = getOcppResponsePayload(parsedMessage);
    return {
      type: 'response',
      messageId,
      payload,
    };
  }

  return null;
}

function logOcppMessage(message) {
  const formatted = formatOcppMessage(message);
  if (!formatted) return false;

  if (formatted.type === 'request') {
    console.log('📤 OCPP Request:');
    console.log(`  Message ID: ${formatted.messageId}`);
    console.log(`  Action: ${formatted.action}`);
    console.log('  Payload:');
    console.log(formatMessage(formatted.payload));
  } else {
    console.log('📥 OCPP Response:');
    console.log(`  Message ID: ${formatted.messageId}`);
    console.log('  Payload:');
    console.log(formatMessage(formatted.payload));
  }

  return true;
}

// Parse command line arguments
function parseArgs() {
  if (process.argv.length !== 3) {
    console.error('❌ Error: Invalid number of arguments');
    console.error(
      'Usage: node test-ws-injection.js <target>:<message_file_path>'
    );
    process.exit(1);
  }

  const arg = process.argv[2];
  const parts = arg.split(':');

  if (parts.length < 2) {
    console.error('❌ Error: Invalid argument format');
    console.error(
      'Usage: node test-ws-injection.js <target>:<message_file_path>'
    );
    process.exit(1);
  }

  const filePath = parts.pop();
  const target = parts.join(':');

  const validTargets = ['all-clients', 'all-upstreams'];
  const validPrefixes = ['client:', 'upstream:'];

  const isValidTarget =
    validTargets.includes(target) ||
    validPrefixes.some((prefix) => target.startsWith(prefix));

  if (!isValidTarget) {
    console.error('❌ Error: Invalid target');
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
    console.log(`📄 Reading message from: ${resolvedPath}`);

    return fs.readFileSync(resolvedPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.error(`❌ Error: File not found: ${filePath}`);
    } else if (error instanceof SyntaxError) {
      console.error(`❌ Error: Invalid JSON in file: ${filePath}`);
      console.error(error.message);
    } else {
      console.error(`❌ Error reading file: ${error.message}`);
    }
    process.exit(1);
  }
}

function createInjectionMessage(target, message) {
  return {
    type: 'inject',
    target,
    message,
  };
}

function logInjectionDetails(target, message) {
  console.log(`🎯 Injecting message to target: ${target}`);
  console.log('📦 Message payload:');
  console.log(formatMessage(message));
}

function handleStatusMessage(response) {
  console.log(
    `📊 Server status: ${response.clients.length} clients, ${response.upstreams.length} upstreams`
  );
}

function handleMessageDirection(response) {
  console.log(`📥 ${response.direction} (${response.connectionId}):`);
}

function handleMatchingResponse(ws, message) {
  console.log('✅ Received matching response:');
  console.log(formatMessage(message));
  ws.close(1000, 'Received matching response');
}

function handleNonOcppMessage(message) {
  console.log(formatMessage(message));
}

function createWebSocketErrorHandler(timeoutId, setConnectionClosed) {
  return (error) => {
    clearTimeout(timeoutId);
    setConnectionClosed();
    console.error('❌ WebSocket error:', error.message);
    process.exit(1);
  };
}

function createWebSocketCloseHandler(timeoutId, setConnectionClosed) {
  return (code, reason) => {
    clearTimeout(timeoutId);
    setConnectionClosed();
    const reasonStr = reason ? reason.toString() : 'No reason provided';
    console.log('👋 Connection closed');
    console.log(`Code: ${code}`);
    console.log(`Reason: ${reasonStr}`);
    process.exit(0);
  };
}

function setupWebSocketHandlers(
  ws,
  target,
  message,
  timeoutId,
  setConnectionClosed,
  setMessageSent
) {
  const parsedMessage = parseMessage(message);
  const requestMessageId = isOcppMessage(message)
    ? getOcppMessageId(parsedMessage)
    : null;

  ws.on('open', () => {
    console.log('✅ Connected to master server');
    clearTimeout(timeoutId);
    logInjectionDetails(target, message);
    ws.send(JSON.stringify(createInjectionMessage(target, message)));
    setMessageSent();
  });

  ws.on('message', (data) => {
    try {
      const response = JSON.parse(data.toString());

      if (response.type === 'status') {
        handleStatusMessage(response);
        return;
      }

      if (response.type === 'message') {
        handleMessageDirection(response);
        try {
          const message = JSON.parse(response.message);
          if (
            requestMessageId &&
            isMatchingOcppResponse(requestMessageId, message)
          ) {
            handleMatchingResponse(ws, message);
            return;
          }
          if (!logOcppMessage(message)) {
            handleNonOcppMessage(message);
          }
        } catch (_e) {
          handleNonOcppMessage(response.message);
        }
        return;
      }

      handleNonOcppMessage(response);
    } catch (_error) {
      handleNonOcppMessage(data.toString());
    }
  });

  ws.on('error', createWebSocketErrorHandler(timeoutId, setConnectionClosed));
  ws.on('close', createWebSocketCloseHandler(timeoutId, setConnectionClosed));
}

function injectMessage(target, message) {
  console.log(BANNER);
  console.log(`🔌 Connecting to master server at ${MASTER_URL}`);

  const ws = new WebSocket(MASTER_URL);
  let connectionClosed = false;
  let _messageSent = false;

  const timeoutId = setTimeout(() => {
    if (!connectionClosed) {
      console.error(`⏰ Connection timeout after ${TIMEOUT}ms`);
      ws.close();
      process.exit(1);
    }
  }, TIMEOUT);

  setupWebSocketHandlers(
    ws,
    target,
    message,
    timeoutId,
    () => {
      connectionClosed = true;
    },
    () => {
      _messageSent = true;
    }
  );
}

// Main function
function main() {
  try {
    const { target, filePath } = parseArgs();
    const message = readMessageFile(filePath);
    injectMessage(target, message);
  } catch (error) {
    console.error('❌ Unexpected error:', error);
    process.exit(1);
  }
}

process.on('SIGINT', () => {
  console.log('👋 Process interrupted');
  process.exit(0);
});

main();
