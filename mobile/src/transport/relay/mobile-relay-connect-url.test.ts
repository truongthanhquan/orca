import { describe, expect, it } from 'vitest'
import { relayConnectWebSocketUrl } from './mobile-relay-connect-url'

describe('relayConnectWebSocketUrl', () => {
  it('opens the existing Orca relay-v1 socket for a custom Cloudflare origin', () => {
    expect(relayConnectWebSocketUrl('https://relay.example.com', 'AbCdEf0123_-xyZ9')).toBe(
      'wss://relay.example.com/v1/connect/AbCdEf0123_-xyZ9'
    )
  })

  it('uses only the origin and replaces any stale route', () => {
    expect(
      relayConnectWebSocketUrl('https://relay.example.com/a/stale/path', 'AbCdEf0123_-xyZ9')
    ).toBe('wss://relay.example.com/v1/connect/AbCdEf0123_-xyZ9')
  })
})
