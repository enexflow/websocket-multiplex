# WebSocket Multiplexer

This is a WebSocket multiplexer that acts as a proxy between clients and an upstream WebSocket server. It allows you to monitor and manipulate WebSocket traffic through a master control connection.

## Configuration

The multiplexer can be configured using environment variables:

- `PORT`: The port on which the multiplexer will listen (default: 8080)
- `UPSTREAM_URL`: The WebSocket server to which connections will be forwarded (default: ws://localhost:9000)

Example:
```bash
PORT=3000 UPSTREAM_URL=ws://api.example.com node websocket-multiplex.js
```

## How It Works

1. The multiplexer creates a WebSocket server that listens for connections
2. When a client connects to a path (e.g., `/chat`), the multiplexer:
   - Creates a connection to the upstream server with the same path
   - Forwards messages between the client and upstream server
   - Reports all activity to the master control connection

## Master Control Connection

The master control connection allows you to:
- Monitor all WebSocket connections and messages
- Inject messages into any client or upstream connection

Connect to the master control at: `ws://localhost:{PORT}/master`

### Example: Connecting to Master Control

```javascript
const WebSocket = require('ws');

// Connect to master control
const master = new WebSocket('ws://localhost:8080/master');

master.on('open', () => {
  console.log('Connected to master control');
});

master.on('message', (data) => {
  const message = JSON.parse(data);
  console.log('Received from master:', message);
});
```

### Example: Monitoring Connections

When you connect to the master, you'll receive a status message with all current connections:

```javascript
master.on('message', (data) => {
  const message = JSON.parse(data);
  
  if (message.type === 'status') {
    console.log('Active clients:', message.clients);
    console.log('Active upstreams:', message.upstreams);
  }
  
  if (message.type === 'connection') {
    console.log(`Connection event: ${message.event} for ${message.connectionId}`);
  }
});
```

### Example: Monitoring Messages

```javascript
master.on('message', (data) => {
  const message = JSON.parse(data);
  
  if (message.type === 'message') {
    console.log(`Message ${message.direction} for ${message.connectionId}:`);
    console.log(message.message);
  }
});
```

### Example: Injecting Messages

You can inject messages to specific clients or upstreams:

```javascript
// Inject message to a specific client
master.send(JSON.stringify({
  type: 'inject',
  target: 'client:/chat',
  message: 'Hello from master!'
}));

// Inject message to a specific upstream
master.send(JSON.stringify({
  type: 'inject',
  target: 'upstream:/chat',
  message: 'Hello to upstream!'
}));

// Inject message to all clients
master.send(JSON.stringify({
  type: 'inject',
  target: 'all-clients',
  message: 'Broadcast to all clients'
}));

// Inject message to all upstreams
master.send(JSON.stringify({
  type: 'inject',
  target: 'all-upstreams',
  message: 'Broadcast to all upstreams'
}));
```

## Use Cases

- Debugging WebSocket applications
- Testing WebSocket server behavior
- Implementing custom protocol transformations
- Monitoring WebSocket traffic
- Creating a WebSocket gateway with custom logic
