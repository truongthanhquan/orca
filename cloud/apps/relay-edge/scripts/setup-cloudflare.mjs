import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const args = new Map()
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]
  if (!key?.startsWith('--')) {
    throw new Error(`invalid argument: ${key ?? ''}`)
  }
  args.set(key.slice(2), process.argv[i + 1])
}

function envOrArg(name, envName = name.toUpperCase().replaceAll('-', '_')) {
  return String(args.get(name) ?? process.env[envName] ?? '').trim()
}

function required(name) {
  const value = envOrArg(name)
  if (!value) {
    throw new Error(`missing --${name}`)
  }
  return value
}

function httpsOrigin(value, name) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`--${name} must be a canonical HTTPS origin`)
  }
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`--${name} must be a canonical HTTPS origin`)
  }
  return url.origin
}

function httpsUrl(value, name) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`--${name} must be an HTTPS URL`)
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error(`--${name} must be an HTTPS URL`)
  }
  return url.toString()
}

const accountId = required('account-id')
const workerName = required('worker-name')
const domain = envOrArg('domain')
const edgeDomain = envOrArg('edge-domain') || (domain ? `edge.${domain}` : '')
const hyperdriveId = required('hyperdrive-id')
const jwksUrl = httpsUrl(required('jwks-url'), 'jwks-url')
const authIssuer = httpsOrigin(required('auth-issuer'), 'auth-issuer')
const audience = required('audience')
const adminIssuer = httpsOrigin(required('admin-issuer'), 'admin-issuer')
const edgeCellId = envOrArg('edge-cell-id') || 'edge'

if (!/^[a-zA-Z0-9_-]{1,64}$/.test(workerName)) {
  throw new Error('--worker-name must contain only letters, numbers, hyphens, and underscores')
}
if (!/^[a-f0-9]{32}$/i.test(accountId)) {
  throw new Error('--account-id must be a 32-character hexadecimal Cloudflare account ID')
}
if (!/^[a-f0-9]{32}$/i.test(hyperdriveId)) {
  throw new Error('--hyperdrive-id must be a 32-character hexadecimal Hyperdrive ID')
}

let hostname = ''
if (domain) {
  try {
    const parsed = new URL(`https://${domain}`)
    if (parsed.hostname !== domain || parsed.username || parsed.password || parsed.port) {
      throw new Error('invalid domain')
    }
    hostname = parsed.hostname
  } catch {
    throw new Error('--domain must be a hostname without scheme or port')
  }
}

let edgeHostname = ''
if (edgeDomain) {
  try {
    const parsed = new URL(`https://${edgeDomain}`)
    if (parsed.hostname !== edgeDomain || parsed.username || parsed.password || parsed.port) {
      throw new Error('invalid edge domain')
    }
    edgeHostname = parsed.hostname
  } catch {
    throw new Error('--edge-domain must be a hostname without scheme or port')
  }
}

if (hostname && (!edgeHostname || edgeHostname === hostname)) {
  throw new Error('--edge-domain must differ from --domain')
}

const routes = hostname
  ? `,\n  "routes": [
    { "pattern": ${JSON.stringify(hostname)}, "custom_domain": true },
    ${edgeHostname ? `{ "pattern": ${JSON.stringify(edgeHostname)}, "custom_domain": true }` : ''}
  ]`
  : ''

const output = `{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": ${JSON.stringify(workerName)},
  "main": "src/index.ts",
  "compatibility_date": "2026-11-01",
  "compatibility_flags": ["nodejs_compat"],
  "account_id": ${JSON.stringify(accountId)},
  "workers_dev": false,
  "alias": {
    "@orca-cloud/relay-contract": "../../packages/relay-contract/src/index.ts",
    "@orca-cloud/relay-contract/persistence-invariants": "../../packages/relay-contract/src/persistence-invariants.ts",
    "@orca-cloud/relay-contract/protocol-limits": "../../packages/relay-contract/src/protocol-limits.ts"
  },
  "durable_objects": {
    "bindings": [
      { "name": "HOST_RELAY", "class_name": "HostRelay" },
      { "name": "SPLICE_RELAY", "class_name": "SpliceRelay" },
      { "name": "USER_HOSTS", "class_name": "UserHosts" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["HostRelay"] },
    { "tag": "v2", "new_sqlite_classes": ["SpliceRelay"] },
    { "tag": "v3", "new_sqlite_classes": ["UserHosts"] }
  ],
  "hyperdrive": [
    { "binding": "HYPERDRIVE", "id": ${JSON.stringify(hyperdriveId)} }
  ],
  "vars": {
    "EDGE_BACKEND": "object",
    "EDGE_CELL_ID": ${JSON.stringify(edgeCellId)},
    "RELAY_JWKS_URL": ${JSON.stringify(jwksUrl)},
    "RELAY_AUTH_ISSUER": ${JSON.stringify(authIssuer)},
    "RELAY_JWT_AUDIENCE": ${JSON.stringify(audience)},
    "ADMIN_ISSUER": ${JSON.stringify(adminIssuer)},
    "PING_INTERVAL_MS": "30000",
    "SILENCE_TIMEOUT_MS": "75000",
    "ORPHAN_GRACE_MS": "30000"${hostname && edgeHostname ? `,
    "DIRECTOR_HOSTNAME": ${JSON.stringify(hostname)},
    "DIRECTOR_EDGE_URL": ${JSON.stringify(`https://${edgeHostname}`)}` : ''}
  }${routes}
}
`

const target = resolve(import.meta.dirname, '..', '.wrangler-deploy-cloudflare.jsonc')
await writeFile(target, output, { encoding: 'utf8', mode: 0o600 })

console.log(`Wrote ${target}`)
console.log('Next:')
console.log('  pnpm exec wrangler secret put ADMIN_SIGNING_KEY --config .wrangler-deploy-cloudflare.jsonc')
console.log('  pnpm --filter @orca-cloud/relay-edge deploy:cloudflare')
