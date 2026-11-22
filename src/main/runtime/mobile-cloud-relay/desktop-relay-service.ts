import type { OrcaCloudAuthConfig } from '../../orca-profiles/cloud-auth/profile-cloud-auth-config'
import type { MobilePairingConnectionContext } from '../rpc/server/runtime-rpc-pairing-types'
import type { OrcaRuntimeRpcServer } from '../rpc/server/runtime-rpc'
import type {
  DeviceCredentialInstalled,
  PairingGetEndpointsParams,
  PairingGetEndpointsResult,
  PairingProvisionRelayParams
} from '../../../shared/remote-runtime/relay/mobile-relay-credential-contract'
import type { RelayHostCloseReason } from '../../../shared/remote-runtime/relay/relay-host-close-reason'
import { readRelayAuthContext } from './authentication/relay-auth-context'
import { relayIdentityKey } from './authentication/relay-auth-identity'
import { RelayAuthCoordinator } from './authentication/relay-auth-coordinator'
import { RelayUnavailableError } from './authentication/relay-readiness'
import { RelaySessionBroker } from './session-lifecycle/relay-session-broker'
import type { MobileRelayStatusPublisher } from '../../../shared/remote-runtime/relay/mobile-relay-status'
import type { PairingRelay } from '../../../shared/remote-runtime/pairing/mobile-relay-pairing-offer'
import type {
  RelayRevokeOutbox,
  RelayDeviceBinding,
  RelayRevokeOutboxItem
} from './pairing/relay-revoke-outbox'
import { deriveRelayHostId } from './director/relay-http-client'
import { RelayDemandLedger } from './demand/relay-demand-ledger'
import { createRelayRegionPreferenceReader } from './region-selection/relay-region-preference-reader'
import { createCustomRelayPairing, CustomRelayBrokerCache } from './custom-relay-broker'
import { routeMobileRelayEndpoints, routeMobileRelayProvision } from './mobile-pairing-routing'
import { readMobilePairingCloudflareRelayUrl } from '../../../shared/remote-runtime/pairing/mobile-pairing-connection-mode'

type DesktopRelayServiceOptions = {
  authConfig: OrcaCloudAuthConfig
  userDataPath: string
  appVersion: string
  runtimeRpc: OrcaRuntimeRpcServer
  onStatus: MobileRelayStatusPublisher
}

// Revive dead brokers lacking retry timers (sleep/token expiry) without requiring user Retry.
const RELAY_LIVENESS_INTERVAL_MS = 5 * 60_000
// Phone readiness budgets are shorter so replies arrive before their deadline.
const PAIRING_MINT_READINESS_WAIT_MS = 20_000
const PHONE_REQUEST_READINESS_WAIT_MS = 10_000

export class DesktopRelayService {
  private readonly authConfig: OrcaCloudAuthConfig
  private readonly userDataPath: string
  private readonly appVersion: string
  private readonly statusPublisher: MobileRelayStatusPublisher
  private readonly customRelayBroker = new CustomRelayBrokerCache()
  private readonly coordinator: RelayAuthCoordinator
  private readonly revokeOutbox: RelayRevokeOutbox
  private readonly runtimeRpc: OrcaRuntimeRpcServer
  private readonly demandLedger: RelayDemandLedger
  private demandExpiryTimer: ReturnType<typeof setTimeout> | null = null
  private livenessTimer: ReturnType<typeof setInterval> | null = null
  private stopped = false

  constructor(options: DesktopRelayServiceOptions) {
    this.authConfig = options.authConfig
    this.userDataPath = options.userDataPath
    this.appVersion = options.appVersion
    this.statusPublisher = options.onStatus
    const keypair = options.runtimeRpc.getE2EEKeypair()
    const mobileSocketWiring = options.runtimeRpc.getMobileSocketWiring()
    if (!keypair || !mobileSocketWiring) {
      throw new Error('mobile_runtime_not_ready')
    }
    this.runtimeRpc = options.runtimeRpc
    this.revokeOutbox = options.runtimeRpc.getRelayRevokeOutbox()
    this.demandLedger = new RelayDemandLedger({
      deviceRegistry: options.runtimeRpc.getDeviceRegistry()!,
      revokeOutbox: this.revokeOutbox,
      relayHostId: deriveRelayHostId(keypair.publicKey)
    })
    const regionPreference = createRelayRegionPreferenceReader(options)
    this.coordinator = new RelayAuthCoordinator({
      readContext: (authOrigin) =>
        readRelayAuthContext(options.authConfig, options.userDataPath, authOrigin),
      hasDemand: ({ identity }) => this.demandLedger.hasDemand(relayIdentityKey(identity)),
      openBroker: async ({ context, isCurrent, refreshAccessToken }) => {
        const broker = await RelaySessionBroker.connect({
          authConfig: options.authConfig,
          accessToken: context.accessToken,
          identity: context.identity,
          keypair,
          appVersion: options.appVersion,
          mobileSocketWiring,
          isCurrent,
          refreshAccessToken,
          // A self-closed broker is neither live nor recovering, so this rebuilds it now.
          onSelfClose: () => this.ensureLive(),
          resolvePreferredRegion: regionPreference.resolvePreferredRegion,
          measureRegionDecision: regionPreference.measureRegionDecision,
          onAssignedCellActive: regionPreference.noteAssignedCell,
          onStatus: options.onStatus
        })
        void this.flushRevokeOutbox(broker)
        return broker
      },
      onStatus: options.onStatus
    })
  }

  start(): void {
    this.refreshDemand()
  }

  ensureLive(): void {
    if (!this.stopped) {
      this.coordinator.ensureLive()
    }
  }

  authMutated(): void {
    this.refreshDemand()
  }

  fenceAndCloseNow(hostCloseReason?: RelayHostCloseReason): void {
    // Hard sign-out fences must stop ticks until the next auth mutation re-arms demand.
    if (this.livenessTimer) {
      clearInterval(this.livenessTimer)
      this.livenessTimer = null
    }
    this.coordinator.fenceAndCloseNow(hostCloseReason)
  }

  async createPairingRelay(
    relayDeviceId: string,
    relayUrlOverride?: string
  ): Promise<{ relay: PairingRelay; binding: RelayDeviceBinding }> {
    if (relayUrlOverride) {
      return await this.withTransientDemand(`pairing:${relayDeviceId}`, async () => {
        const broker = await this.requireCustomBroker(relayUrlOverride)
        return await createCustomRelayPairing(broker, relayDeviceId)
      })
    }
    return await this.withTransientDemand(`pairing:${relayDeviceId}`, async () => {
      const broker = await this.requireActiveBroker(PAIRING_MINT_READINESS_WAIT_MS)
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
    })
  }

  onDeviceRevokeQueued(item: RelayRevokeOutboxItem): void {
    this.refreshDemand()
    const broker = this.coordinator.getActiveBroker()
    if (
      broker instanceof RelaySessionBroker &&
      broker.hostId === item.relayHostId &&
      broker.ownerIdentityKey === item.ownerIdentityKey
    ) {
      void this.flushRevoke(broker, item)
    }
  }

  async getEndpoints(
    context: MobilePairingConnectionContext,
    params: PairingGetEndpointsParams
  ): Promise<PairingGetEndpointsResult> {
    this.requireMobileDevice(context.deviceId)
    return await routeMobileRelayEndpoints({
      runtimeRpc: this.runtimeRpc,
      context,
      params,
      waitMs: PHONE_REQUEST_READINESS_WAIT_MS,
      requireCustomBroker: (url) => this.requireCustomBroker(url),
      getCloudflareRelayUrl: () =>
        readMobilePairingCloudflareRelayUrl(this.runtimeRpc.requireStore().getSettings()),
      requireActiveBroker: (waitMs) => this.requireActiveBroker(waitMs),
      withTransientDemand: (key, operation) => this.withTransientDemand(key, operation),
      assertRelayHost: (relayContext, broker) => this.assertRelayHost(relayContext, broker)
    })
  }

  async provisionRelay(
    context: MobilePairingConnectionContext,
    params: PairingProvisionRelayParams
  ): Promise<DeviceCredentialInstalled> {
    this.requireMobileDevice(context.deviceId)
    return await routeMobileRelayProvision({
      runtimeRpc: this.runtimeRpc,
      context,
      params,
      waitMs: PHONE_REQUEST_READINESS_WAIT_MS,
      requireCustomBroker: (url) => this.requireCustomBroker(url),
      requireActiveBroker: (waitMs) => this.requireActiveBroker(waitMs),
      withTransientDemand: (key, operation) => this.withTransientDemand(key, operation),
      assertRelayHost: (relayContext, broker) => this.assertRelayHost(relayContext, broker),
      setRelayBinding: (relayContext, broker) =>
        this.runtimeRpc.setMobileRelayBinding(relayContext.deviceId, {
          relayHostId: broker.hostId,
          relayDeviceId: relayContext.deviceId,
          ownerIdentityKey: broker.ownerIdentityKey
        })
    })
  }

  demandStateChanged(): void {
    this.refreshDemand()
  }

  stop(): void {
    this.stopped = true
    if (this.demandExpiryTimer) {
      clearTimeout(this.demandExpiryTimer)
      this.demandExpiryTimer = null
    }
    if (this.livenessTimer) {
      clearInterval(this.livenessTimer)
      this.livenessTimer = null
    }
    this.coordinator.stop()
  }

  private async flushRevokeOutbox(broker: RelaySessionBroker): Promise<void> {
    for (const item of this.revokeOutbox.pendingFor(broker.ownerIdentityKey, broker.hostId)) {
      await this.flushRevoke(broker, item)
    }
  }

  private requireMobileDevice(deviceId: string): void {
    if (this.runtimeRpc.getDeviceRegistry()?.getDevice(deviceId)?.scope !== 'mobile') {
      throw new Error('mobile_device_not_found')
    }
  }

  private assertRelayHost(
    context: MobilePairingConnectionContext,
    broker: RelaySessionBroker
  ): void {
    if (
      context.transport.transport === 'relay' &&
      context.transport.relayHostId !== broker.hostId
    ) {
      throw new Error('stale_relay_connection')
    }
  }

  private async flushRevoke(
    broker: RelaySessionBroker,
    item: RelayRevokeOutboxItem
  ): Promise<void> {
    try {
      await broker.revokeDevice(item.relayDeviceId, item.reqId)
      this.revokeOutbox.remove(item.reqId)
      this.refreshDemand()
    } catch {
      // Durable revoke reqId survives reconnect; remote retry must not delay local revocation.
    }
  }

  private async withTransientDemand<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const release = this.demandLedger.acquireTransient(key)
    this.refreshDemand()
    try {
      return await operation()
    } finally {
      release()
      this.refreshDemand()
    }
  }

  private async requireActiveBroker(waitMs: number): Promise<RelaySessionBroker> {
    const readiness = await this.coordinator.waitForReadiness(waitMs)
    if (readiness.ready && readiness.broker instanceof RelaySessionBroker) {
      return readiness.broker
    }
    throw new RelayUnavailableError(
      readiness.ready ? { reason: 'control_not_active', retryAt: null } : readiness
    )
  }

  private async requireCustomBroker(relayUrl: string): Promise<RelaySessionBroker> {
    const keypair = this.runtimeRpc.getE2EEKeypair()
    const mobileSocketWiring = this.runtimeRpc.getMobileSocketWiring()
    if (!keypair || !mobileSocketWiring) {
      throw new RelayUnavailableError({ reason: 'control_not_active', retryAt: null })
    }
    return await this.customRelayBroker.get({
      authConfig: this.authConfig,
      userDataPath: this.userDataPath,
      appVersion: this.appVersion,
      keypair,
      mobileSocketWiring,
      relayUrl,
      onStatus: this.statusPublisher
    })
  }

  private refreshDemand(): void {
    if (this.stopped) {
      return
    }
    if (!this.livenessTimer) {
      this.livenessTimer = setInterval(() => this.ensureLive(), RELAY_LIVENESS_INTERVAL_MS)
    }
    if (this.demandExpiryTimer) {
      clearTimeout(this.demandExpiryTimer)
      this.demandExpiryTimer = null
    }
    this.coordinator.reconcile()
    const expiresAt = this.demandLedger.nextPendingExpiry()
    if (expiresAt !== null) {
      // Expired unscanned invites must release standing control even without a surviving renderer.
      const delay = Math.max(1, expiresAt - Date.now() + 1)
      this.demandExpiryTimer = setTimeout(() => this.refreshDemand(), delay)
    }
  }
}
