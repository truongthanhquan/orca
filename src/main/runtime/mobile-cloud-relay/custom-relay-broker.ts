import type { OrcaCloudAuthConfig } from '../../orca-profiles/cloud-auth/profile-cloud-auth-config'
import type { E2EEKeypair } from '../rpc/server/pairing/e2ee-keypair'
import type { MobileSocketWiring } from '../rpc/mobile/mobile-socket-wiring'
import type { MobileRelayStatusPublisher } from '../../../shared/remote-runtime/relay/mobile-relay-status'
import { readRelayAuthContext } from './authentication/relay-auth-context'
import { RelayUnavailableError } from './authentication/relay-readiness'
import { RelaySessionBroker } from './session-lifecycle/relay-session-broker'
import type { MobilePairingConnectionContext } from '../rpc/server/runtime-rpc-pairing-types'
import type {
  DeviceCredentialInstalled,
  PairingGetEndpointsParams,
  PairingGetEndpointsResult,
  PairingProvisionRelayParams
} from '../../../shared/remote-runtime/relay/mobile-relay-credential-contract'
import type { PairingRelay } from '../../../shared/remote-runtime/pairing/mobile-relay-pairing-offer'
import type { RelayDeviceBinding } from './pairing/relay-revoke-outbox'
import { pairingAuthorizationForContext } from './pairing/relay-pairing-authorization'

export async function openCustomRelayBroker(args: {
  authConfig: OrcaCloudAuthConfig
  userDataPath: string
  appVersion: string
  keypair: E2EEKeypair
  mobileSocketWiring: MobileSocketWiring
  relayUrl: string
  onStatus: MobileRelayStatusPublisher
  onClosed: () => void
}): Promise<RelaySessionBroker> {
  const customAuthConfig = {
    ...args.authConfig,
    relayDirectorUrl: args.relayUrl
  }
  const context = await readRelayAuthContext(customAuthConfig, args.userDataPath)
  if (!context) {
    throw new RelayUnavailableError({ reason: 'signed_out', retryAt: null })
  }
  return await RelaySessionBroker.connect({
    authConfig: customAuthConfig,
    accessToken: context.accessToken,
    identity: context.identity,
    keypair: args.keypair,
    appVersion: args.appVersion,
    mobileSocketWiring: args.mobileSocketWiring,
    isCurrent: () => true,
    refreshAccessToken: async (authOrigin) => {
      const refreshed = await readRelayAuthContext(customAuthConfig, args.userDataPath, authOrigin)
      return refreshed ? { accessToken: refreshed.accessToken } : { accessToken: null }
    },
    onSelfClose: args.onClosed,
    onStatus: args.onStatus
  })
}

export async function createCustomRelayPairing(
  broker: RelaySessionBroker,
  relayDeviceId: string
): Promise<{ relay: PairingRelay; binding: RelayDeviceBinding }> {
  const relay = await broker.createPairingRelay(relayDeviceId)
  return {
    relay,
    binding: {
      relayHostId: broker.hostId,
      relayDeviceId,
      ownerIdentityKey: broker.ownerIdentityKey,
      inviteExpiresAt: relay.inviteExpiresAt
    }
  }
}

export async function customRelayEndpoints(
  broker: RelaySessionBroker,
  context: MobilePairingConnectionContext,
  params: PairingGetEndpointsParams
): Promise<PairingGetEndpointsResult> {
  const result: PairingGetEndpointsResult = { v: 1, relay: broker.endpoint }
  if (params.installReqId) {
    result.installStatus = await broker.credentialInstallStatus(
      context.deviceId,
      params.installReqId
    )
  }
  return result
}

export async function provisionCustomRelay(
  broker: RelaySessionBroker,
  context: MobilePairingConnectionContext,
  params: PairingProvisionRelayParams
): Promise<DeviceCredentialInstalled> {
  if (!broker.endpoint) {
    throw new Error('relay_control_not_active')
  }
  const authorization = pairingAuthorizationForContext(context, broker.hostId)
  if (!authorization) {
    throw new Error('relay_provision_authorization_unavailable')
  }
  return await broker.installCredential(context.deviceId, params, authorization)
}

export class CustomRelayBrokerCache {
  private broker: RelaySessionBroker | null = null
  private relayUrl: string | null = null

  async get(args: {
    authConfig: OrcaCloudAuthConfig
    userDataPath: string
    appVersion: string
    keypair: E2EEKeypair
    mobileSocketWiring: MobileSocketWiring
    relayUrl: string
    onStatus: MobileRelayStatusPublisher
  }): Promise<RelaySessionBroker> {
    if (this.broker?.isLive() && this.relayUrl === args.relayUrl) {
      return this.broker
    }
    this.broker?.closeNow()
    this.relayUrl = args.relayUrl
    this.broker = await openCustomRelayBroker({
      ...args,
      onClosed: () => {
        if (this.relayUrl === args.relayUrl) {
          this.broker = null
          this.relayUrl = null
        }
      }
    })
    return this.broker
  }

  close(): void {
    this.broker?.closeNow()
    this.broker = null
    this.relayUrl = null
  }
}
