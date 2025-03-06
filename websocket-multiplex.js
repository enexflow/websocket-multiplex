const WebSocket = require("ws");
const http = require("node:http");
const url = require("node:url");

// Configuration
const PORT = process.env.PORT || 8080;
const MASTER_PORT = process.env.MASTER_PORT || 8081;
const UPSTREAM_URL = process.env.UPSTREAM_URL || "ws://localhost:9000";
const LOG_LEVEL = process.env.LOG_LEVEL || "INFO";

// Logging levels
const LOG_LEVELS = {
	ERROR: 0,
	WARN: 1,
	INFO: 2,
	DEBUG: 3,
};

// Current log level
const CURRENT_LOG_LEVEL =
	LOG_LEVELS[LOG_LEVEL] !== undefined ? LOG_LEVELS[LOG_LEVEL] : LOG_LEVELS.INFO;

// Logger
const logger = {
	error: (message, ...args) => {
		if (CURRENT_LOG_LEVEL >= LOG_LEVELS.ERROR) {
			console.error(`[ERROR] ${message}`, ...args);
		}
	},
	warn: (message, ...args) => {
		if (CURRENT_LOG_LEVEL >= LOG_LEVELS.WARN) {
			console.warn(`[WARN] ${message}`, ...args);
		}
	},
	info: (message, ...args) => {
		if (CURRENT_LOG_LEVEL >= LOG_LEVELS.INFO) {
			console.log(`[INFO] ${message}`, ...args);
		}
	},
	debug: (message, ...args) => {
		if (CURRENT_LOG_LEVEL >= LOG_LEVELS.DEBUG) {
			console.log(`[DEBUG] ${message}`, ...args);
		}
	},
};

// Create HTTP servers
const server = http.createServer();
const masterServer = http.createServer();

// WebSocket server options with logging
const wsOptions = {
	server,
	perMessageDeflate: true,
};

const masterWsOptions = {
	server: masterServer,
	perMessageDeflate: true,
};

// Enable WebSocket internal logging if debug level
if (CURRENT_LOG_LEVEL >= LOG_LEVELS.DEBUG) {
	WebSocket.createWebSocketStream.prototype.on = function (event, listener) {
		logger.debug(`WebSocketStream event: ${event}`);
		return this.on.call(this, event, listener);
	};
}

// Create WebSocket servers
const wss = new WebSocket.Server(wsOptions);
const masterWss = new WebSocket.Server(masterWsOptions);

// Store all connections
const connections = {
	clients: new Map(), // client connections
	upstreams: new Map(), // upstream connections
	master: null, // master control connection
};

// Log WebSocket server events
wss.on("listening", () => {
	logger.info(`WebSocket server listening on port ${PORT}`);
});

wss.on("error", (error) => {
	logger.error("WebSocket server error:", error);
});

masterWss.on("listening", () => {
	logger.info(`Master WebSocket server listening on port ${MASTER_PORT}`);
});

masterWss.on("error", (error) => {
	logger.error("Master WebSocket server error:", error);
});

// Handle master control connections
masterWss.on("connection", (ws, req) => {
	const ip = req.socket.remoteAddress;
	logger.info(`Master control connected from ${ip}`);

	if (connections.master) {
		logger.warn("Replacing existing master connection");
		connections.master.close(1000, "New master connection established");
	}
	connections.master = ws;

	// Send current connection status
	const status = {
		type: "status",
		clients: Array.from(connections.clients.keys()),
		upstreams: Array.from(connections.upstreams.keys()),
	};
	ws.send(JSON.stringify(status));
	logger.debug("Sent status to master:", status);

	// Handle messages from master
	ws.on("message", (message) => {
		try {
			const data = JSON.parse(message);
			logger.debug("Received message from master:", data);

			if (data.type === "inject") {
				// Inject message to a specific client or upstream
				if (data.target === "all-clients") {
					logger.info("Master injecting message to all clients");
					for (const client of connections.clients.values()) {
						client.ws.send(data.message);
					}
				} else if (data.target === "all-upstreams") {
					logger.info("Master injecting message to all upstreams");
					for (const upstream of connections.upstreams.values()) {
						upstream.ws.send(data.message);
					}
				} else if (data.target.startsWith("client:")) {
					const clientId = data.target.substring(7);
					logger.info(`Master injecting message to client: ${clientId}`);
					const client = connections.clients.get(clientId);
					if (client) {
						client.ws.send(data.message);
					} else {
						logger.warn(`Client ${clientId} not found for message injection`);
					}
				} else if (data.target.startsWith("upstream:")) {
					const upstreamId = data.target.substring(9);
					logger.info(`Master injecting message to upstream: ${upstreamId}`);
					const upstream = connections.upstreams.get(upstreamId);
					if (upstream) {
						upstream.ws.send(data.message);
					} else {
						logger.warn(
							`Upstream ${upstreamId} not found for message injection`,
						);
					}
				}
			}
		} catch (error) {
			logger.error("Error processing master message:", error);
		}
	});

	// Handle master disconnection
	ws.on("close", (code, reason) => {
		logger.info(
			`Master control disconnected. Code: ${code}, Reason: ${reason || "No reason provided"}`,
		);
		connections.master = null;
	});

	ws.on("error", (error) => {
		logger.error("Master connection error:", error);
	});
});

// Handle new WebSocket connections
wss.on("connection", (ws, req) => {
	const ip = req.socket.remoteAddress;
	const pathname = url.parse(req.url).pathname;
	const connectionId = pathname;

	logger.info(`Client connected: ${pathname} from ${ip}`);
	logger.info("Client connection headers:", req.headers);

	// Connect to upstream
	const upstreamUrl = UPSTREAM_URL + pathname;
	logger.info(`Connecting to upstream: ${upstreamUrl}`);
	const upstreamWs = new WebSocket(upstreamUrl, [
		"ocpp1.6", // Common OCPP subprotocols
		"ocpp2.0",
		"ocpp2.0.1",
	]);

	// Store connection info
	connections.clients.set(pathname, {
		ws,
		upstreamId: pathname,
		connected: false,
		ip,
	});

	connections.upstreams.set(pathname, {
		ws: upstreamWs,
		clientId: pathname,
		connected: false,
	});

	// Handle upstream connection
	upstreamWs.on("open", () => {
		logger.info(`Upstream connected for client ${pathname}`);
		const client = connections.clients.get(pathname);
		const upstream = connections.upstreams.get(pathname);

		if (client) client.connected = true;
		if (upstream) upstream.connected = true;

		// Log connection details
		logger.debug(`Upstream connection for ${pathname}:`, {
			url: upstreamUrl,
			protocol: upstreamWs.protocol,
		});

		// Notify master
		if (connections.master) {
			connections.master.send(
				JSON.stringify({
					type: "connection",
					event: "upstream-connected",
					connectionId,
				}),
			);
		}
	});

	// Forward messages from client to upstream
	ws.on("message", (message) => {
		const upstream = connections.upstreams.get(pathname);

		if (CURRENT_LOG_LEVEL >= LOG_LEVELS.DEBUG) {
			const messageStr = message.toString();
			const truncatedMsg =
				messageStr.length > 200
					? `${messageStr.substring(0, 200)}... (${messageStr.length} bytes)`
					: messageStr;
			logger.debug(`Client → Upstream [${pathname}]: ${truncatedMsg}`);
		}

		// Notify master
		if (connections.master) {
			const notification = {
				type: "message",
				direction: "client-to-upstream",
				connectionId,
				message: message.toString(),
			};
			connections.master.send(JSON.stringify(notification));
		}

		// Forward to upstream if connected
		if (upstream?.connected) {
			upstream.ws.send(message);
		} else {
			logger.warn(
				`Cannot forward message to upstream for ${pathname}: not connected`,
			);
		}
	});

	// Forward messages from upstream to client
	upstreamWs.on("message", (message) => {
		if (CURRENT_LOG_LEVEL >= LOG_LEVELS.DEBUG) {
			const messageStr = message.toString();
			const truncatedMsg =
				messageStr.length > 200
					? `${messageStr.substring(0, 200)}... (${messageStr.length} bytes)`
					: messageStr;
			logger.debug(`Upstream → Client [${pathname}]: ${truncatedMsg}`);
		}

		// Notify master
		if (connections.master) {
			const notification = {
				type: "message",
				direction: "upstream-to-client",
				connectionId,
				message: message.toString(),
			};
			connections.master.send(JSON.stringify(notification));
		}

		// Forward to client
		ws.send(message);
	});

	// Handle client disconnection
	ws.on("close", (code, reason) => {
		logger.info(
			`Client disconnected: ${pathname}. Code: ${code}, Reason: ${reason || "No reason provided"}`,
		);

		// Close upstream connection
		const upstream = connections.upstreams.get(pathname);
		if (upstream) {
			logger.debug(`Closing upstream connection for ${pathname}`);
			upstream.ws.close();
			connections.upstreams.delete(pathname);
		}

		connections.clients.delete(pathname);

		// Notify master
		if (connections.master) {
			const notification = {
				type: "connection",
				event: "client-disconnected",
				connectionId,
				code,
				reason: reason?.toString(),
			};
			connections.master.send(JSON.stringify(notification));
			logger.debug("Notified master of client disconnection:", notification);
		}
	});

	// Handle upstream disconnection
	upstreamWs.on("close", (code, reason) => {
		const closeInfo = {
			code,
			reason: reason?.toString() || "No reason provided",
			wasClean: code === 1000 || code === 1001,
		};

		logger.info(`Upstream disconnected for client ${pathname}:`, closeInfo);

		// Log important close codes
		const closeMessages = {
			1006: `Abnormal closure with upstream ${pathname}`,
			1011: `Unexpected condition prevented upstream ${pathname} from fulfilling request`,
			1012: `Service restart with upstream ${pathname}`,
			1013: `Server overloaded at upstream ${pathname}`,
			1014: `Bad gateway with upstream ${pathname}`,
		};

		if (closeMessages[code]) {
			logger.error(closeMessages[code]);
		}

		// Notify master
		if (connections.master) {
			connections.master.send(
				JSON.stringify({
					type: "connection",
					event: "upstream-disconnected",
					connectionId,
					details: closeInfo,
				}),
			);
		}

		// Close client connection if upstream disconnects
		const client = connections.clients.get(pathname);
		if (client) {
			logger.debug(
				`Closing client connection for ${pathname} due to upstream disconnect`,
			);
			client.ws.close();
			connections.clients.delete(pathname);
		}

		connections.upstreams.delete(pathname);
	});

	// Handle errors
	ws.on("error", (error) => {
		logger.error(`Client error (${pathname}):`, error);
	});

	upstreamWs.on("error", (error) => {
		const errorInfo = {
			message: error.message,
			code: error.code,
			target: upstreamUrl,
			path: pathname,
			time: new Date().toISOString(),
		};

		logger.error(
			`Error on the upstream connection to ${upstreamUrl}:`,
			errorInfo,
		);

		// Common error types with context
		const errorMessages = {
			ECONNREFUSED: `Connection refused to ${upstreamUrl}`,
			ENOTFOUND: `DNS resolution failed for ${upstreamUrl}`,
			ETIMEDOUT: `Connection timed out to ${upstreamUrl}`,
		};

		if (errorMessages[error.code]) {
			logger.error(errorMessages[error.code]);
		} else if (error.message?.includes("unexpected server response")) {
			logger.error(
				`Unexpected response from ${upstreamUrl}. Server might not support WebSockets.`,
			);
		}

		// Notify master
		if (connections.master) {
			connections.master.send(
				JSON.stringify({
					type: "error",
					source: "upstream",
					connectionId,
					details: errorInfo,
				}),
			);
		}
	});

	// Log ping/pong for debugging
	if (CURRENT_LOG_LEVEL >= LOG_LEVELS.DEBUG) {
		ws.on("ping", (data) => {
			logger.debug(
				`Received ping from client ${pathname}: ${data?.toString() || "empty"}`,
			);
		});

		ws.on("pong", (data) => {
			logger.debug(
				`Received pong from client ${pathname}: ${data?.toString() || "empty"}`,
			);
		});

		upstreamWs.on("ping", (data) => {
			logger.debug(
				`Received ping from upstream ${pathname}: ${data?.toString() || "empty"}`,
			);
		});

		upstreamWs.on("pong", (data) => {
			logger.debug(
				`Received pong from upstream ${pathname}: ${data?.toString() || "empty"}`,
			);
		});

		// Add event handlers for additional WebSocket events
		upstreamWs.on("unexpected-response", (request, response) => {
			const statusInfo = {
				code: response.statusCode,
				message: response.statusMessage,
				url: upstreamUrl,
				time: new Date().toISOString(),
			};

			logger.error(
				`Unexpected response from upstream ${pathname}:`,
				statusInfo,
			);

			// Status code context
			if (response.statusCode === 401 || response.statusCode === 403) {
				logger.error(`Authentication failed for ${upstreamUrl}`);
			} else if (response.statusCode === 404) {
				logger.error(`Resource not found at ${upstreamUrl}`);
			} else if (response.statusCode >= 500) {
				logger.error(`Server error at ${upstreamUrl}`);
			}

			// Notify master
			if (connections.master) {
				connections.master.send(
					JSON.stringify({
						type: "error",
						source: "upstream",
						event: "unexpected-response",
						connectionId,
						details: statusInfo,
					}),
				);
			}
		});

		upstreamWs.on("upgrade", (response) => {
			if (CURRENT_LOG_LEVEL >= LOG_LEVELS.DEBUG) {
				logger.debug(`Upstream ${pathname} upgrade:`, {
					headers: response.headers,
					status: `${response.statusCode} ${response.statusMessage}`,
				});
			}
		});
	}
});

// Start the servers
server.listen(PORT, () => {
	logger.info(`WebSocket multiplexer running on port ${PORT}`);
	logger.info(`Upstream URL: ${UPSTREAM_URL}`);
	logger.info(`Logging level: ${LOG_LEVEL}`);
});

masterServer.listen(MASTER_PORT, () => {
	logger.info(`Master control available at: ws://localhost:${MASTER_PORT}`);
});

// Handle server shutdown
process.on("SIGINT", () => {
	logger.info("Shutting down server...");

	// Close all connections
	logger.debug(`Closing ${connections.clients.size} client connections`);
	for (const client of connections.clients.values()) {
		client.ws.close(1000, "Server shutting down");
	}

	logger.debug(`Closing ${connections.upstreams.size} upstream connections`);
	for (const upstream of connections.upstreams.values()) {
		upstream.ws.close(1000, "Server shutting down");
	}

	if (connections.master) {
		logger.debug("Closing master connection");
		connections.master.close(1000, "Server shutting down");
	}

	server.close(() => {
		masterServer.close(() => {
			logger.info("Servers shut down");
			process.exit(0);
		});
	});
});

// Log uncaught exceptions
process.on("uncaughtException", (error) => {
	logger.error("Uncaught exception:", error);
});

process.on("unhandledRejection", (reason, promise) => {
	logger.error("Unhandled rejection at:", promise, "reason:", reason);
});
