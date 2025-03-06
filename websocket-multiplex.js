const WebSocket = require('ws');
const http = require('node:http');
const url = require('node:url');

// Configuration
const PORT = process.env.PORT || 8080;
const MASTER_PORT = process.env.MASTER_PORT || 8081;
const UPSTREAM_URL = process.env.UPSTREAM_URL || 'ws://localhost:9000';

// Create HTTP servers
const server = http.createServer();
const masterServer = http.createServer();

// Create WebSocket servers
const wss = new WebSocket.Server({ server });
const masterWss = new WebSocket.Server({ server: masterServer });

// Store all connections
const connections = {
  clients: new Map(),  // client connections
  upstreams: new Map(), // upstream connections
  master: null         // master control connection
};

// Handle master control connections
masterWss.on('connection', (ws) => {
  if (connections.master) {
    connections.master.close(1000, 'New master connection established');
  }
  connections.master = ws;
  console.log('Master control connected');
  
  // Send current connection status
  const status = {
    type: 'status',
    clients: Array.from(connections.clients.keys()),
    upstreams: Array.from(connections.upstreams.keys())
  };
  ws.send(JSON.stringify(status));
  
  // Handle messages from master
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      if (data.type === 'inject') {
        // Inject message to a specific client or upstream
        if (data.target === 'all-clients') {
          for (const client of connections.clients.values()) {
            client.ws.send(data.message);
          }
        } else if (data.target === 'all-upstreams') {
          for (const upstream of connections.upstreams.values()) {
            upstream.ws.send(data.message);
          }
        } else if (data.target.startsWith('client:')) {
          const clientId = data.target.substring(7);
          const client = connections.clients.get(clientId);
          if (client) {
            client.ws.send(data.message);
          }
        } else if (data.target.startsWith('upstream:')) {
          const upstreamId = data.target.substring(9);
          const upstream = connections.upstreams.get(upstreamId);
          if (upstream) {
            upstream.ws.send(data.message);
          }
        }
      }
    } catch (error) {
      console.error('Error processing master message:', error);
    }
  });
  
  // Handle master disconnection
  ws.on('close', () => {
    console.log('Master control disconnected');
    connections.master = null;
  });
});

// Handle new WebSocket connections
wss.on('connection', (ws, req) => {
  const pathname = url.parse(req.url).pathname;
  const connectionId = pathname;
  
  // Regular client connection
  console.log(`Client connected: ${pathname}`);
  
  // Connect to upstream
  const upstreamWs = new WebSocket(`${UPSTREAM_URL}/${pathname}`);
  
  // Store connection info
  connections.clients.set(pathname, { 
    ws, 
    upstreamId: pathname,
    connected: false
  });
  
  connections.upstreams.set(pathname, { 
    ws: upstreamWs, 
    clientId: pathname,
    connected: false
  });
  
  // Handle upstream connection
  upstreamWs.on('open', () => {
    console.log(`Upstream connected for client ${pathname}`);
    const client = connections.clients.get(pathname);
    const upstream = connections.upstreams.get(pathname);
    
    if (client) client.connected = true;
    if (upstream) upstream.connected = true;
    
    // Notify master
    if (connections.master) {
      connections.master.send(JSON.stringify({
        type: 'connection',
        event: 'upstream-connected',
        connectionId,
      }));
    }
  });
  
  // Forward messages from client to upstream
  ws.on('message', (message) => {
    const upstream = connections.upstreams.get(pathname);
    
    // Notify master
    if (connections.master) {
      connections.master.send(JSON.stringify({
        type: 'message',
        direction: 'client-to-upstream',
        connectionId,
        message: message.toString()
      }));
    }
    
    // Forward to upstream if connected
    if (upstream?.connected) {
      upstream.ws.send(message);
    }
  });
  
  // Forward messages from upstream to client
  upstreamWs.on('message', (message) => {
    // Notify master
    if (connections.master) {
      connections.master.send(JSON.stringify({
        type: 'message',
        direction: 'upstream-to-client',
        connectionId,
        message: message.toString()
      }));
    }
    
    // Forward to client
    ws.send(message);
  });
  
  // Handle client disconnection
  ws.on('close', () => {
    console.log(`Client disconnected: ${pathname}`);
    
    // Close upstream connection
    const upstream = connections.upstreams.get(pathname);
    if (upstream) {
      upstream.ws.close();
      connections.upstreams.delete(pathname);
    }
    
    connections.clients.delete(pathname);
    
    // Notify master
    if (connections.master) {
      connections.master.send(JSON.stringify({
        type: 'connection',
        event: 'client-disconnected',
        connectionId
      }));
    }
  });
  
  // Handle upstream disconnection
  upstreamWs.on('close', () => {
    console.log(`Upstream disconnected for client ${pathname}`);
    
    // Notify master
    if (connections.master) {
      connections.master.send(JSON.stringify({
        type: 'connection',
        event: 'upstream-disconnected',
        connectionId
      }));
    }
    
    // Close client connection if upstream disconnects
    const client = connections.clients.get(pathname);
    if (client) {
      client.ws.close();
      connections.clients.delete(pathname);
    }
    
    connections.upstreams.delete(pathname);
  });
  
  // Handle errors
  ws.on('error', (error) => {
    console.error(`Client error (${pathname}):`, error);
  });
  
  upstreamWs.on('error', (error) => {
    console.error(`Upstream error (${pathname}):`, error);
  });
});

// Start the servers
server.listen(PORT, () => {
  console.log(`WebSocket multiplexer running on port ${PORT}`);
  console.log(`Forwarding to upstream: ${UPSTREAM_URL}`);
});

masterServer.listen(MASTER_PORT, () => {
  console.log(`Master control available at: ws://localhost:${MASTER_PORT}`);
});

// Handle server shutdown
process.on('SIGINT', () => {
  console.log('Shutting down server...');
  
  // Close all connections
  for (const client of connections.clients.values()) {
    client.ws.close();
  }
  
  for (const upstream of connections.upstreams.values()) {
    upstream.ws.close();
  }
  
  if (connections.master) {
    connections.master.close();
  }
  
  server.close(() => {
    masterServer.close(() => {
      console.log('Servers shut down');
      process.exit(0);
    });
  });
});