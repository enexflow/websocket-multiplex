/**
 * Calls the prod CitrineOS API (port 8080) with a Keycloak token, without printing any secret.
 *
 * Starts kubectl port-forwards to keycloak and citrineos-server, gets a client_credentials token
 * for the `timeseries_api` client (secret read from the k8s secret `keycloak`), then sends the request.
 *
 * Usage:
 *   node citrine-api.js <GET|POST|PUT|DELETE> <path?query> [--body <json file>] [--identity <chargerId>]
 *     [--password-file <path>]
 *
 * Placeholders replaced in the body and the path:
 *   <IDENTITY>   the value of --identity
 *   <PASSWORD>   the content of --password-file (body only)
 *
 * Examples:
 *   # Store a charger password hash in Citrine only (setOnCharger is inverted, see TECH-2622)
 *   node citrine-api.js POST /data/configuration/password --body OCPP201/citrine-password.json \
 *     --identity 101005386 --password-file ~/Downloads/101005386.txt
 *   # Ask a directly connected charger for variables (results land in Citrine's device model)
 *   node citrine-api.js POST '/ocpp/2.0.1/monitoring/getVariables?identifier=<IDENTITY>&tenantId=1' \
 *     --body OCPP201/citrine-getVariables-smartCharging.json --identity 101005386
 *   # Read what Citrine stored for a charger
 *   node citrine-api.js GET '/data/monitoring/variableAttribute?stationId=101005386&tenantId=1'
 */

const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');

const USAGE =
  'Usage: node citrine-api.js <GET|POST|PUT|DELETE> <path?query> [--body <json file>] [--identity <chargerId>] [--password-file <path>] [--context <ctx>] [--namespace <ns>]';
const REALM_TOKEN_PATH = '/auth/realms/patterm/protocol/openid-connect/token';

function parseArgs(argv) {
  const options = {
    body: null,
    identity: null,
    passwordFile: null,
    context: 'enexflow_prod',
    namespace: 'prod',
  };
  const flags = {
    '--body': 'body',
    '--identity': 'identity',
    '--password-file': 'passwordFile',
    '--context': 'context',
    '--namespace': 'namespace',
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const key = flags[argv[i]];
    if (key) {
      if (argv[i + 1] === undefined)
        throw new Error(`Missing value for ${argv[i]}`);
      options[key] = argv[++i];
    } else if (argv[i].startsWith('--')) {
      throw new Error(`Unknown option ${argv[i]}`);
    } else {
      positional.push(argv[i]);
    }
  }
  if (positional.length !== 2) throw new Error('Expected a method and a path');
  options.method = positional[0].toUpperCase();
  options.path = positional[1].startsWith('/')
    ? positional[1]
    : `/${positional[1]}`;
  options.path = replaceIdentity(options.path, options);
  return options;
}

function replaceIdentity(text, options) {
  if (!text.includes('<IDENTITY>')) return text;
  if (!options.identity)
    throw new Error('<IDENTITY> placeholder needs --identity');
  return text.replaceAll('<IDENTITY>', options.identity);
}

function readBody(options) {
  if (!options.body) return undefined;
  let text = replaceIdentity(fs.readFileSync(options.body, 'utf8'), options);
  if (text.includes('<PASSWORD>')) {
    if (!options.passwordFile)
      throw new Error(`${options.body} needs --password-file`);
    const password = fs
      .readFileSync(options.passwordFile.replace(/^~/, os.homedir()), 'utf8')
      .trim();
    text = text.replaceAll('<PASSWORD>', password);
  }
  return JSON.stringify(JSON.parse(text));
}

function startPortForward({ context, namespace }, service, remotePort) {
  return new Promise((resolve, reject) => {
    const child = spawn('kubectl', [
      '--context',
      context,
      '-n',
      namespace,
      'port-forward',
      service,
      `:${remotePort}`,
    ]);
    let output = '';
    const onData = (data) => {
      output += data.toString();
      const port = /Forwarding from 127\.0\.0\.1:(\d+)/.exec(output)?.[1];
      if (port) resolve({ child, port });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) =>
      reject(
        new Error(
          `port-forward ${service} exited (code ${code}): ${output.trim()}`
        )
      )
    );
  });
}

async function getToken(options, keycloakPort) {
  const secret = Buffer.from(
    execFileSync('kubectl', [
      '--context',
      options.context,
      '-n',
      options.namespace,
      'get',
      'secret',
      'keycloak',
      '-o',
      'jsonpath={.data.ts_api_client_secret}',
    ]).toString(),
    'base64'
  ).toString();
  // Host header so the token issuer matches what Citrine expects
  const response = await fetch(
    `http://127.0.0.1:${keycloakPort}${REALM_TOKEN_PATH}`,
    {
      method: 'POST',
      headers: {
        Host: 'keycloak:8180',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: 'timeseries_api',
        client_secret: secret,
      }),
    }
  );
  const json = await response.json();
  if (!json.access_token)
    throw new Error(
      `Keycloak token error: ${json.error} ${json.error_description || ''}`
    );
  return json.access_token;
}

/**
 * Never echo stored password hashes: blanks the value of any device model entry whose variable is a password.
 */
function redactPasswords(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return text;
  }
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;
    const out = {};
    for (const [key, value] of Object.entries(node)) out[key] = walk(value);
    const name = node.variable?.name || node.Variable?.name || '';
    if (/password/i.test(name) && 'value' in out) out.value = '<hidden>';
    return out;
  };
  return JSON.stringify(walk(json), null, 2);
}

async function main() {
  let options;
  let body;
  try {
    options = parseArgs(process.argv.slice(2));
    body = readBody(options);
  } catch (error) {
    console.error(`❌ ${error.message}\n${USAGE}`);
    process.exitCode = 1;
    return;
  }

  const children = [];
  try {
    const keycloak = await startPortForward(options, 'svc/keycloak', 8180);
    children.push(keycloak.child);
    const citrine = await startPortForward(
      options,
      'svc/citrineos-server',
      8080
    );
    children.push(citrine.child);

    const token = await getToken(options, keycloak.port);
    const response = await fetch(
      `http://127.0.0.1:${citrine.port}${options.path}`,
      {
        method: options.method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body,
      }
    );
    const text = await response.text();
    console.log(`${options.method} ${options.path} -> ${response.status}`);
    console.log(redactPasswords(text));
    if (!response.ok) process.exitCode = 1;
  } catch (error) {
    console.error(`❌ ${error.message}`);
    process.exitCode = 1;
  } finally {
    for (const child of children) child.kill();
  }
}

main();
