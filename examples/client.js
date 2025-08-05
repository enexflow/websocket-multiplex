const WebSocket = require('ws');
const readline = require('node:readline');

const SERVER_URL = process.env.WS_URL || 'ws://localhost:8080';
const PATH = process.env.WS_PATH || '/';

console.log(`Connecting to ${SERVER_URL}${PATH}...`);

const ws = new WebSocket(SERVER_URL + PATH);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

ws.on('open', () => {
  console.log('Connected to WebSocket server!');
  console.log('Type messages and press Enter to send. Type "quit" to exit.\n');

  rl.setPrompt('> ');
  rl.prompt();

  rl.on('line', (input) => {
    const message = input.trim();

    if (message === 'quit') {
      console.log('Closing connection...');
      ws.close();
      rl.close();
      return;
    }

    if (message) {
      ws.send(message);
      console.log(`Sent: ${message}`);
    }

    rl.prompt();
  });
});

ws.on('message', (data) => {
  const message = data.toString();
  console.log(`\nReceived: ${message}`);
  rl.prompt();
});

ws.on('close', (code, reason) => {
  console.log(
    `\nConnection closed. Code: ${code}, Reason: ${reason || 'No reason provided'}`
  );
  rl.close();
  process.exit(0);
});

ws.on('error', (error) => {
  console.error('WebSocket error:', error.message);
  rl.close();
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('\nReceived SIGINT. Closing connection...');
  ws.close();
  rl.close();
  process.exit(0);
});
