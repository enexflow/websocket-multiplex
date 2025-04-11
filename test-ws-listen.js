const WebSocket = require('ws');
const util = require('node:util');

const MASTER_URL = process.env.MASTER_URL || 'ws://localhost:8081';

// Format timestamp in a friendly way
function formatTimestamp() {
  const now = new Date();
  return now.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

const BANNER = `
╔═════════════════════════════════════════════════════╗
║ 🎧 WebSocket Multiplexer Listener                   ║
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
    } catch (e) {
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

// Create a message box with header
function createMessageBox(type, direction, connectionId, content) {
  const directionInfo = {
    'client-to-upstream': 'client → upstream',
    'upstream-to-client': 'upstream → client',
  }[direction] || direction;
  const typeEmoji =
    {
      message: '📨',
      connection: '🔌',
      error: '❌',
      status: '📊',
      raw: '📝',
    }[type] || '📝';

  const header = `${typeEmoji} ${formatTimestamp()} ${connectionId || 'all'}${directionInfo ? ` (${directionInfo})` : ''}`;
  
  if (type === 'connection') {
    const event = content.event;
    const eventEmoji = {
      'client-connected': '🟢',
      'client-disconnected': '🔴',
      'upstream-connected': '🟢',
      'upstream-disconnected': '🔴'
    }[event] || '🔌';
    
    const eventText = {
      'client-connected': 'Client connected',
      'client-disconnected': 'Client disconnected',
      'upstream-connected': 'Upstream connected',
      'upstream-disconnected': 'Upstream disconnected'
    }[event] || event;
    
    const details = content.code ? ` (code: ${content.code}${content.reason ? `, reason: ${content.reason}` : ''})` : '';
    return `${header} ${eventEmoji} ${eventText}${details}`;
  }

  const formattedContent = formatMessage(content);
  return `${header} ${formattedContent}`;
}

// Parse command line arguments
function parseArgs() {
  if (process.argv.length !== 3) {
    console.error('❌ Error: Missing target argument');
    console.error('Usage: node test-ws-listen.js <target>');
    console.error('\nValid targets:');
    console.error('  all     - Listen to all connections');
    console.error('  /path   - Listen to a specific path (e.g. /chat)');
    console.error('\nExamples:');
    console.error('  node test-ws-listen.js all');
    console.error('  node test-ws-listen.js /chat');
    process.exit(1);
  }

  const target = process.argv[2];

  if (target !== 'all' && !target.startsWith('/')) {
    console.error('❌ Error: Invalid target');
    console.error('Target must be "all" or start with "/" (e.g. /chat)');
    process.exit(1);
  }

  return target;
}

/**
 * Connect to master server and listen for messages
 * @param {string} target - The target to listen to
 */
function listenToMessages(target) {
  console.log(BANNER);
  console.log(`🔌 Connecting to master server at ${MASTER_URL}`);

  const ws = new WebSocket(MASTER_URL);

  ws.on('open', () => {
    console.log('✅ Connected to master server');
    console.log(`🎯 Listening for messages from target: ${target}`);
  });

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      if (target === 'all' || message.connectionId === target) {
        console.log(
          createMessageBox(
            message.type,
            message.direction,
            message.connectionId,
            message.message || message
          )
        );
      }
    } catch (error) {
      console.log(
        createMessageBox('raw', 'unknown', 'unknown', data.toString())
      );
    }
  });

  ws.on('error', (error) => {
    console.error('❌ WebSocket error:', error.message);
    process.exit(1);
  });

  ws.on('close', (code, reason) => {
    const reasonStr = reason ? reason.toString() : 'No reason provided';
    console.log('👋 Connection closed');
    console.log(`Code: ${code}`);
    console.log(`Reason: ${reasonStr}`);
    process.exit(0);
  });
}

// Main function
function main() {
  const target = parseArgs();
  listenToMessages(target);
}

// Start the script
main();
