const WebSocket = require('ws');

// Simulates N charge points connecting through the multiplexer (or, in the
// docker-compose HA setup, through the LB in front of several instances),
// each with its own reconnect-with-backoff loop - so killing/restarting a
// multiplexer instance mid-test can be observed without the whole harness
// dying. Not an OCPP protocol test: just enough traffic (a boot message on
// connect, a heartbeat on an interval) to see connections get proxied and
// survive a reconnect.

const WS_URL = process.env.WS_URL || 'ws://localhost:8080';
const CLIENT_COUNT = Number(process.env.CLIENT_COUNT) || 10;
const CHARGE_POINT_PREFIX = process.env.CHARGE_POINT_PREFIX || 'LOAD';
const HEARTBEAT_INTERVAL_MS =
  Number(process.env.HEARTBEAT_INTERVAL_MS) || 5000;
const MIN_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 10000;

function log(chargePointId, ...args) {
  console.log(`[${chargePointId}]`, ...args);
}

class SimulatedChargePoint {
  constructor(chargePointId) {
    this.chargePointId = chargePointId;
    this.backoffMs = MIN_BACKOFF_MS;
    this.heartbeatTimer = null;
    this.stopped = false;
    this.connect();
  }

  connect() {
    if (this.stopped) return;
    const url = `${WS_URL}/${this.chargePointId}`;
    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      this.backoffMs = MIN_BACKOFF_MS;
      log(this.chargePointId, `connected (${url})`);
      this.send({ type: 'boot', chargePointId: this.chargePointId });

      this.heartbeatTimer = setInterval(() => {
        this.send({ type: 'heartbeat', at: new Date().toISOString() });
      }, HEARTBEAT_INTERVAL_MS);
    });

    this.ws.on('message', (data) => {
      log(this.chargePointId, 'received:', data.toString());
    });

    this.ws.on('close', (code, reason) => {
      clearInterval(this.heartbeatTimer);
      log(
        this.chargePointId,
        `disconnected (code ${code}, reason: ${reason || 'none'})`
      );
      this.scheduleReconnect();
    });

    this.ws.on('error', (error) => {
      log(this.chargePointId, 'error:', error.message);
    });
  }

  send(payload) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  scheduleReconnect() {
    if (this.stopped) return;
    log(this.chargePointId, `reconnecting in ${this.backoffMs}ms`);
    setTimeout(() => this.connect(), this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
  }

  stop() {
    this.stopped = true;
    clearInterval(this.heartbeatTimer);
    this.ws?.close(1000, 'harness shutting down');
  }
}

const chargePoints = [];
for (let i = 0; i < CLIENT_COUNT; i++) {
  chargePoints.push(
    new SimulatedChargePoint(`${CHARGE_POINT_PREFIX}-${i}`)
  );
}

console.log(
  `Started ${CLIENT_COUNT} simulated charge points against ${WS_URL} (prefix ${CHARGE_POINT_PREFIX})`
);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const cp of chargePoints) cp.stop();
    setTimeout(() => process.exit(0), 200);
  });
}
