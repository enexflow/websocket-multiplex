const WebSocket = require('ws');

// Configuration
const WS_URL = process.env.WS_URL || 'ws://localhost:8080';
const CHARGE_POINT_ID = 'YOLO';
const OCPP_VERSION = '1.6';

// Generate a random UUID v4
function createMessageId() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// Create an OCPP message
function createOcppMessage(messageType, action, payload) {
  switch (messageType) {
    case 'CALL':
      return [2, createMessageId(), action, payload];
    case 'CALLRESULT':
      return [3, payload.messageId, payload.result];
    case 'CALLERROR':
      return [
        4,
        payload.messageId,
        payload.errorCode,
        payload.errorDescription,
        payload.errorDetails,
      ];
    default:
      throw new Error(`Unknown message type: ${messageType}`);
  }
}

// Connect to the multiplexer
console.log(`Connecting to multiplexer at ${WS_URL}/${CHARGE_POINT_ID}`);
const ws = new WebSocket(`${WS_URL}/${CHARGE_POINT_ID}`, [
  `ocpp${OCPP_VERSION}`,
  'ocpp2.0',
  'ocpp2.0.1',
]);

// Handle connection events
ws.on('open', () => {
  console.log('Connected to multiplexer');

  // Send BootNotification
  const bootNotification = createOcppMessage('CALL', 'BootNotification', {
    chargePointVendor: 'Test Vendor',
    chargePointModel: 'Test Model',
    chargePointSerialNumber: 'SN123456',
    chargeBoxSerialNumber: 'CB123456',
    firmwareVersion: '1.0.0',
    iccid: '',
    imsi: '',
    meterType: 'Test Meter',
    meterSerialNumber: 'MSN123456',
  });

  console.log('Sending BootNotification:', JSON.stringify(bootNotification));
  ws.send(JSON.stringify(bootNotification));

  // Schedule a Heartbeat message after 5 seconds
  setTimeout(() => {
    const heartbeat = createOcppMessage('CALL', 'Heartbeat', {});
    console.log('Sending Heartbeat:', JSON.stringify(heartbeat));
    ws.send(JSON.stringify(heartbeat));
  }, 5000);

  // Schedule a StatusNotification after 10 seconds
  setTimeout(() => {
    const statusNotification = createOcppMessage('CALL', 'StatusNotification', {
      connectorId: 1,
      errorCode: 'NoError',
      status: 'Available',
      timestamp: new Date().toISOString(),
      info: 'Test status notification',
      vendorId: 'Test Vendor',
      vendorErrorCode: '',
    });
    console.log(
      'Sending StatusNotification:',
      JSON.stringify(statusNotification)
    );
    ws.send(JSON.stringify(statusNotification));
  }, 10000);
});

// Handle incoming messages
ws.on('message', (data) => {
  try {
    const message = JSON.parse(data.toString());
    console.log('Received message:', JSON.stringify(message));

    // Handle different message types
    const messageTypeId = message[0];

    if (messageTypeId === 2) {
      // Handle CALL message (from server to client)
      const messageId = message[1];
      const action = message[2];
      const payload = message[3];

      console.log(`Received CALL: ${action}, messageId: ${messageId}`);

      // Respond to specific actions
      if (action === 'Reset') {
        const response = createOcppMessage('CALLRESULT', null, {
          messageId: messageId,
          result: { status: 'Accepted' },
        });
        console.log('Sending Reset response:', JSON.stringify(response));
        ws.send(JSON.stringify(response));
      } else if (action === 'RemoteStartTransaction') {
        const response = createOcppMessage('CALLRESULT', null, {
          messageId: messageId,
          result: { status: 'Accepted' },
        });
        console.log(
          'Sending RemoteStartTransaction response:',
          JSON.stringify(response)
        );
        ws.send(JSON.stringify(response));

        // Simulate starting a transaction
        setTimeout(() => {
          const startTransaction = createOcppMessage(
            'CALL',
            'StartTransaction',
            {
              connectorId: 1,
              idTag: payload.idTag || 'TEST_TAG',
              meterStart: 0,
              timestamp: new Date().toISOString(),
              reservationId: payload.reservationId || 0,
            }
          );
          console.log(
            'Sending StartTransaction:',
            JSON.stringify(startTransaction)
          );
          ws.send(JSON.stringify(startTransaction));
        }, 2000);
      }
    } else if (messageTypeId === 3) {
      // Handle CALLRESULT
      const messageId = message[1];
      const result = message[2];

      console.log(`Received CALLRESULT for messageId: ${messageId}`);

      // If this is a response to BootNotification, schedule a MeterValues message
      if (result.status === 'Accepted' && result.currentTime) {
        setTimeout(() => {
          const meterValues = createOcppMessage('CALL', 'MeterValues', {
            connectorId: 1,
            transactionId: 1,
            meterValue: [
              {
                timestamp: new Date().toISOString(),
                sampledValue: [
                  {
                    value: '10.5',
                    context: 'Sample.Periodic',
                    format: 'Raw',
                    measurand: 'Energy.Active.Import.Register',
                    unit: 'kWh',
                  },
                ],
              },
            ],
          });
          console.log('Sending MeterValues:', JSON.stringify(meterValues));
          ws.send(JSON.stringify(meterValues));
        }, 15000);
      }
    } else if (messageTypeId === 4) {
      // Handle CALLERROR
      const messageId = message[1];
      const errorCode = message[2];
      const errorDescription = message[3];

      console.log(
        `Received CALLERROR for messageId: ${messageId}, error: ${errorCode} - ${errorDescription}`
      );
    }
  } catch (error) {
    console.error('Error processing message:', error);
  }
});

// Handle errors and disconnection
ws.on('error', (error) => {
  console.error('WebSocket error:', error);
});

ws.on('upgrade', (request, socket, head) => {
  console.log('Upgraded: ', request.headers);
});

ws.on('unexpected-response', (request, response) => {
  console.log(
    'Unexpected response:',
    response.statusCode,
    response.statusMessage,
    response.headers
  );
});

ws.on('close', (code, reason) => {
  const codes = {
    1000: 'Normal Closure',
    1001: 'Going Away',
    1002: 'Protocol Error',
    1003: 'Unsupported Data',
    1004: 'Reserved',
    1005: 'No Status Rcvd',
    1006: 'Abnormal Closure',
    1007: 'Invalid Frame Payload Data',
    1008: 'Policy Violation',
    1009: 'Message Too Big',
    1010: 'Mandatory Extension Missing',
    1011: 'Internal Server Error',
    1012: 'Service Restart',
  };
  console.log(
    `Connection closed. Code: ${code} (${codes[code] || 'Unknown'}), Reason: ${reason || 'No reason provided'}`
  );
});

// Handle process termination
process.on('SIGINT', () => {
  console.log('Closing connection...');

  // Send a final message before disconnecting
  const stopTransaction = createOcppMessage('CALL', 'StopTransaction', {
    transactionId: 1,
    meterStop: 20,
    timestamp: new Date().toISOString(),
    reason: 'Remote',
  });

  console.log('Sending StopTransaction:', JSON.stringify(stopTransaction));
  ws.send(JSON.stringify(stopTransaction));

  // Close the connection after sending the final message
  setTimeout(() => {
    ws.close();
    process.exit(0);
  }, 1000);
});
