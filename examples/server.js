const WebSocket = require('ws');
const readline = require('readline');

const PORT = process.env.PORT || 9000;

console.log(`Starting WebSocket server on port ${PORT}...`);

const wss = new WebSocket.Server({ port: PORT });

const clients = new Set();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

wss.on('listening', () => {
  console.log(`WebSocket server listening on ws://localhost:${PORT}`);
  console.log('Type messages and press Enter to broadcast to all clients. Type "quit" to exit.\n');
  
  rl.setPrompt('> ');
  rl.prompt();
  
  rl.on('line', (input) => {
    const message = input.trim();
    
    if (message === 'quit') {
      console.log('Shutting down server...');
      wss.close();
      rl.close();
      return;
    }
    
    if (message && clients.size > 0) {
      console.log(`Broadcasting to ${clients.size} client(s): ${message}`);
      clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(`[Server]: ${message}`);
        }
      });
    } else if (message && clients.size === 0) {
      console.log('No clients connected to broadcast to.');
    }
    
    rl.prompt();
  });
});

wss.on('connection', (ws, req) => {
  const clientInfo = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
  console.log(`\nClient connected: ${clientInfo} on path: ${req.url}`);
  console.log(`Total clients: ${clients.size + 1}`);
  
  clients.add(ws);
  
  ws.send('Welcome to the WebSocket server!');
  
  ws.on('message', (data) => {
    const message = data.toString();
    console.log(`\nReceived from ${clientInfo}: ${message}`);
    
    clients.forEach(client => {
      if (client !== ws && client.readyState === WebSocket.OPEN) {
        client.send(`[${clientInfo}]: ${message}`);
      }
    });
    
    rl.prompt();
  });
  
  ws.on('close', (code, reason) => {
    clients.delete(ws);
    console.log(`\nClient disconnected: ${clientInfo}. Code: ${code}, Reason: ${reason || 'No reason provided'}`);
    console.log(`Total clients: ${clients.size}`);
    rl.prompt();
  });
  
  ws.on('error', (error) => {
    console.error(`Client error (${clientInfo}):`, error.message);
    clients.delete(ws);
  });
  
  rl.prompt();
});

wss.on('error', (error) => {
  console.error('Server error:', error);
});

process.on('SIGINT', () => {
  console.log('\nReceived SIGINT. Shutting down server...');
  wss.close();
  rl.close();
  process.exit(0);
}); 