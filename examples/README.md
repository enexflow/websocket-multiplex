# WebSocket Examples

This folder contains simple example programs to demonstrate the WebSocket multiplexer in action.

## Files

- `client.js` - A simple WebSocket client that connects through the multiplexer
- `server.js` - A simple WebSocket server that the multiplexer connects to

## Quick Start

1. **Start the multiplexer** (from the root directory):
   ```bash
   node websocket-multiplex.js
   ```

2. **Start the server** (in a new terminal):
   ```bash
   node examples/server.js
   ```

3. **Start the client** (in a third terminal):
   ```bash
   node examples/client.js
   ```

## How it works

```
[Client] ←→ [Multiplexer:8080] ←→ [Server:9000]
```

- The **client** connects to the multiplexer on `ws://localhost:8080/`
- The **multiplexer** forwards messages to the server on `ws://localhost:9000/`
- Messages flow bidirectionally through the multiplexer

## Usage

### Client
- Type messages and press Enter to send them to the server
- Type `quit` to disconnect and exit
- Received messages are displayed with "Received:" prefix

### Server
- Type messages and press Enter to broadcast them to all connected clients
- Type `quit` to shut down the server
- Shows connection/disconnection events and received messages

## Environment Variables

### Client
- `WS_URL` - WebSocket server URL (default: `ws://localhost:8080`)
- `WS_PATH` - Connection path (default: `/`)

### Server
- `PORT` - Port to listen on (default: `9000`)

## Examples

### Connect to different path:
```bash
WS_PATH=/my-device node examples/client.js
```

### Connect to different multiplexer:
```bash
WS_URL=ws://example.com:8080 node examples/client.js
```

### Run server on different port:
```bash
PORT=9001 node examples/server.js
```

Then update the multiplexer's upstream URL:
```bash
UPSTREAM_URL=ws://localhost:9001 node websocket-multiplex.js
``` 