# Deploying the Orca relay on Cloudflare

The public `cloud/apps/relay-edge` Worker can relay Orca desktop and mobile WebSocket
traffic. The existing mobile app does not need rebuilding: it accepts a canonical HTTPS
relay origin, upgrades it to `wss://`, and speaks the same relay-v1 protocol.

Cloudflare WebSocket support alone is not sufficient. The deployed Worker must retain
the Orca `HostRelay`, `SpliceRelay`, and optional `UserHosts` Durable Object bindings,
authorization contract, pairing credentials, database, and director routes.

## What the relay does

1. The desktop opens `/v1/host/control`.
2. The phone opens `/v1/connect/<relay-host-id>`.
3. The desktop attaches `/v1/host/data/<connection-id>` with a one-time ticket.
4. The Worker splices frames between the authenticated sockets.
5. The existing mobile relay encryption remains end-to-end between desktop and phone.

Production use requires an account-specific deploy configuration. Do not deploy
`EDGE_BACKEND=spike` for real users; it is only for local protocol testing.

## 1. Create and prepare the Cloudflare account

1. Create or sign in to [Cloudflare](https://dash.cloudflare.com/).
2. Add a domain to Cloudflare if the relay will use a custom hostname.
3. Enable Durable Objects for the account.
4. Create a Hyperdrive configuration for production Postgres.
5. Prepare Postgres and apply `cloud/packages/postgres-schema`.
6. Log in with Wrangler:

   ```sh
   cd cloud
   pnpm install
   pnpm --filter @orca-cloud/relay-edge exec wrangler login
   pnpm --filter @orca-cloud/relay-edge exec wrangler whoami
   ```

## 2. Generate a deploy configuration

The checked-in `wrangler.jsonc` is local-only. It deliberately has no public route and
uses a local Hyperdrive connection. Generate an ignored production configuration:

```sh
cd cloud
pnpm --filter @orca-cloud/relay-edge setup:cloudflare \
  --account-id <CLOUDFLARE_ACCOUNT_ID> \
  --worker-name orca-relay-edge \
  --domain relay.example.com \
  --edge-domain edge.relay.example.com \
  --hyperdrive-id <HYPERDRIVE_CONFIGURATION_ID> \
  --jwks-url https://login.example.com/.well-known/jwks.json \
  --auth-issuer https://login.example.com \
  --audience orca-relay \
  --admin-issuer https://director.example.com
```

The script writes `.wrangler-deploy-cloudflare.jsonc` inside
`cloud/apps/relay-edge`. Its file name is ignored by Git. The script validates HTTPS
origins and required IDs, but private infrastructure values remain yours.

Set signing and ingress secrets with Wrangler instead of putting them in the config:

```sh
cd cloud/apps/relay-edge
pnpm exec wrangler secret put ADMIN_SIGNING_KEY --config .wrangler-deploy-cloudflare.jsonc
pnpm exec wrangler secret put INGRESS_TOKENS --config .wrangler-deploy-cloudflare.jsonc
pnpm exec wrangler secret put INGRESS_SECRETS --config .wrangler-deploy-cloudflare.jsonc
```

Set `INGRESS_ORIGINS` and `INGRESS_SOURCE_CIDRS` only when a trusted ingress proxy is in
the architecture. Direct Cloudflare routing needs neither.

## 3. Deploy

```sh
cd cloud
pnpm --filter @orca-cloud/relay-edge deploy:cloudflare
```

Verify the public origin:

```sh
curl https://relay.example.com/health
```

Expected response:

```json
{"ok":true,"connectionCapacityProtocol":2}
```

Run the relay tests before a public deployment:

```sh
cd cloud
pnpm --filter @orca-cloud/relay-edge test
pnpm --filter @orca-cloud/relay-edge typecheck
```

## 4. Configure Orca desktop

Set the desktop build environment to the canonical HTTPS origin:

```sh
ORCA_RELAY_URL=https://relay.example.com
```

The desktop uses this origin for Relay JWTs and pairing offers. The matching auth issuer,
JWKS URL, JWT audience, director, database, and Hyperdrive must all agree. Package or
run the desktop with the same deployment values:

```sh
ORCA_CLOUD_API_URL=https://login.example.com
ORCA_RELAY_URL=https://relay.example.com
ORCA_CLOUD_RELAY_TOKEN_URL=https://login.example.com/v1/desktop/auth/relay-token
```

The pairing UI's existing **Orca Relay** option then points to the deployed relay. It
does not require a mobile app rebuild or a separate mobile configuration: the pairing
offer contains the director/cell WebSocket origins and the mobile app upgrades HTTPS
origins to WSS automatically.

## Compatibility and security checks

- Test phone pairing, reconnect, desktop reconnect, expiry, and revocation.
- Keep `/__admin/*` unavailable outside the signed director.
- Use HTTPS and WSS only; never advertise `http://` or `ws://`.
- Use Cloudflare WAF/rate limits as a front-door defense, in addition to Orca limits.
- Store Postgres URLs, signing keys, and ingress secrets only in secrets/configuration,
  never in source control.
- The deployed relay can be Cloudflare-hosted and the existing app store app remains
  compatible as long as it implements the public relay-v1 protocol.
