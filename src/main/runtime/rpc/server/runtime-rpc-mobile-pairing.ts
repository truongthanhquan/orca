import {
  canonicalMobilePairingCloudflareRelayUrl,
  normalizeMobilePairingConnectionMode,
  type MobilePairingConnectionMode
} from '../../../../shared/remote-runtime/pairing/mobile-pairing-connection-mode'
import {
  mobileRelayMintFailureFromUnknown,
  type MobileRelayMintFailure
} from '../../../../shared/remote-runtime/relay/mobile-relay-mint-failure'
import { encodePairingOffer } from '../../../../shared/remote-runtime/pairing/pairing'
import { PAIRING_OFFER_VERSION } from '../../../../shared/remote-runtime/pairing/mobile-relay-pairing-offer'
import { NETWORK_EXPOSURE_FAILED_GUIDANCE } from './pairing/network/network-exposure-guidance'
import { createOwnerPairingOffer } from './pairing/pairing-offer-requests'
import type { PairingOffersRpcContext } from '../core'
import { RuntimeRpcPairing } from './runtime-rpc-pairing'
import { withTimeout } from '../../../../shared/concurrency/promise-timeout-fallback'
import {
  DEVICE_REGISTRY_UNAVAILABLE_GUIDANCE,
  pairingUnavailable,
  type MobilePairingOffer,
  type MobileRelayPairingProvider,
  type PairingOfferUnavailable
} from './runtime-rpc-pairing-types'

const RELAY_PROVIDER_INSTALL_WAIT_MS = 15_000

export class RuntimeRpcMobilePairing extends RuntimeRpcPairing {
  protected override ownerPairingOffers(): PairingOffersRpcContext {
    return {
      create: async (params, createdByDeviceId, createdByClientInstanceId) => {
        const offer = await createOwnerPairingOffer(this, params, undefined, createdByDeviceId)
        if (offer.available && createdByClientInstanceId) {
          this.deviceRegistry?.setOriginClientInstance(offer.deviceId, createdByClientInstanceId)
        }
        return offer
      }
    }
  }

  async createMobilePairingOffer(args: {
    address?: string | null
    connectionMode?: MobilePairingConnectionMode
    name?: string
    rotate?: boolean
    offerTtlMs?: number
    createdByDeviceId?: string
  }): Promise<MobilePairingOffer> {
    if (args.connectionMode === 'cloudflare-relay') {
      this.mobilePairingOfferGeneration += 1
      return this.createMobilePairingOfferSerial(args, this.mobilePairingOfferGeneration)
    }
    try {
      await this.ensureNetworkExposure()
    } catch (error) {
      console.error(
        '[runtime] Network exposure failed while creating a mobile pairing offer:',
        error
      )
      return pairingUnavailable('network_exposure_failed', NETWORK_EXPOSURE_FAILED_GUIDANCE)
    }
    if (args.connectionMode === 'local-only') {
      this.mobilePairingOfferGeneration += 1
      return this.createMobilePairingOfferSerial(args, this.mobilePairingOfferGeneration)
    }
    const inFlight = this.mobileRelayPairingOfferInFlight
    if (
      inFlight?.generation === this.mobilePairingOfferGeneration &&
      inFlight.address === (args.address ?? null) &&
      inFlight.createdByDeviceId === args.createdByDeviceId &&
      (inFlight.rotate || args.rotate !== true)
    ) {
      return inFlight.request
    }
    const generation = ++this.mobilePairingOfferGeneration
    const request = this.mobileRelayPairingOfferQueue.then(() =>
      generation === this.mobilePairingOfferGeneration
        ? this.createMobilePairingOfferSerial(args, generation)
        : this.relayPairingRequestSuperseded()
    )
    this.mobileRelayPairingOfferQueue = request.then(
      () => undefined,
      () => undefined
    )
    this.mobileRelayPairingOfferInFlight = {
      generation,
      address: args.address ?? null,
      rotate: args.rotate === true,
      createdByDeviceId: args.createdByDeviceId,
      request
    }
    void request.then(
      () => {
        if (this.mobileRelayPairingOfferInFlight?.request === request) {
          this.mobileRelayPairingOfferInFlight = null
        }
      },
      () => {
        if (this.mobileRelayPairingOfferInFlight?.request === request) {
          this.mobileRelayPairingOfferInFlight = null
        }
      }
    )
    return request
  }

  protected async createMobilePairingOfferSerial(
    args: {
      address?: string | null
      connectionMode?: MobilePairingConnectionMode
      name?: string
      rotate?: boolean
      offerTtlMs?: number
      createdByDeviceId?: string
    },
    generation: number
  ): Promise<MobilePairingOffer> {
    // Renderer input is untrusted; only explicit local-only may suppress Relay provisioning.
    const connectionMode = normalizeMobilePairingConnectionMode(args.connectionMode)
    // Expired offers leave through discard so their Relay invites are revoked too.
    for (const expired of this.deviceRegistry?.listExpiredPairingOffers('mobile') ?? []) {
      this.discardPendingMobilePairingDevice(expired.deviceId)
    }
    const pending = this.deviceRegistry?.getPendingDevice(
      'mobile',
      args.offerTtlMs,
      [],
      args.createdByDeviceId
    )
    const switchingPendingMode =
      pending != null &&
      this.deviceRegistry?.getMobilePairingConnectionMode(pending.deviceId) !== connectionMode
    if (args.rotate || switchingPendingMode) {
      // Durably enqueue cloud revocation for every offer rotation drops, or old invites outlive the QR.
      for (const offer of this.deviceRegistry?.listPendingDevices('mobile') ?? []) {
        if (offer.relayBinding && !this.queueRelayDeviceRevoke(offer.relayBinding)) {
          return pairingUnavailable(
            'device_registry_unavailable',
            'Could not persist Relay cleanup before rotating the pairing code.'
          )
        }
      }
    }
    const direct = this.createPairingOffer({
      ...args,
      rotate: args.rotate || switchingPendingMode,
      scope: 'mobile'
    })
    if (!direct.available) {
      return direct
    }
    const createdNewPendingDevice = pending?.deviceId !== direct.deviceId
    let connectionModeStored = false
    try {
      connectionModeStored =
        this.deviceRegistry?.setMobilePairingConnectionMode(direct.deviceId, connectionMode) ??
        false
    } catch (error) {
      console.error('[runtime] Failed to persist the pairing connection mode:', error)
    }
    // Persist credential mode or refuse; a QR must never pair under an unstored default policy.
    if (!connectionModeStored) {
      if (createdNewPendingDevice) {
        this.discardPendingMobilePairingDevice(direct.deviceId)
      }
      return pairingUnavailable('device_registry_unavailable', DEVICE_REGISTRY_UNAVAILABLE_GUIDANCE)
    }
    if (connectionMode === 'local-only') {
      return { ...direct, connectionMode: 'local-only' }
    }
    const cloudflareRelayUrl = canonicalMobilePairingCloudflareRelayUrl(
      connectionMode === 'cloudflare-relay'
        ? this.runtime.requireStore().getSettings().mobilePairingCloudflareRelayUrl
        : null
    )
    if (connectionMode === 'cloudflare-relay' && cloudflareRelayUrl === null) {
      return pairingUnavailable(
        'relay_mint_failed',
        'Set the My Cloudflare Relay director URL in Settings → Mobile before pairing.'
      )
    }
    const refuseAutomaticWithoutRelay = (
      relayFailure: MobileRelayMintFailure
    ): PairingOfferUnavailable => {
      if (createdNewPendingDevice) {
        this.discardPendingMobilePairingDevice(direct.deviceId)
      }
      return {
        available: false,
        reason: 'relay_mint_failed',
        guidance:
          'Orca Relay could not create a pairing invite. Use LAN (Tailscale or same Wi‑Fi) or retry Relay.',
        relayFailure
      }
    }
    if (!this.mobileRelayPairingProvider && this.mobileRelayPairingProviderInstaller) {
      await withTimeout(
        this.mobileRelayPairingProviderInstaller(),
        RELAY_PROVIDER_INSTALL_WAIT_MS,
        undefined
      )
    }
    const relayProvider = this.mobileRelayPairingProvider
    if (!relayProvider) {
      return refuseAutomaticWithoutRelay({
        code: 'relay_provider_unavailable',
        stage: 'provider_missing',
        message: 'Orca Relay is not available on this host'
      })
    }
    const device = this.deviceRegistry?.getDevice(direct.deviceId)
    const publicKeyB64 = this.getE2EEPublicKey()
    if (!device?.token || !publicKeyB64) {
      return refuseAutomaticWithoutRelay({
        code: 'e2ee_key_unavailable',
        stage: 'e2ee_missing',
        message: 'E2EE public key unavailable for Relay pairing'
      })
    }
    let relayPairing: Awaited<ReturnType<MobileRelayPairingProvider['createPairingRelay']>>
    try {
      relayPairing = await relayProvider.createPairingRelay(
        device.deviceId,
        connectionMode === 'cloudflare-relay' ? cloudflareRelayUrl : undefined
      )
    } catch (error) {
      const relayFailure = mobileRelayMintFailureFromUnknown({
        stage: 'create_pairing_relay',
        error,
        fallbackCode: 'relay_mint_failed',
        fallbackMessage: 'Relay pairing invite request failed'
      })
      console.warn(`[runtime] Failed to create Relay pairing invite: ${relayFailure.code}`)
      return refuseAutomaticWithoutRelay(relayFailure)
    }
    const currentDevice = this.deviceRegistry?.getDevice(device.deviceId)
    if (
      generation !== this.mobilePairingOfferGeneration ||
      relayProvider !== this.mobileRelayPairingProvider ||
      currentDevice?.token !== device.token ||
      this.deviceRegistry?.getMobilePairingConnectionMode(device.deviceId) !== connectionMode
    ) {
      this.queueOrRetainRelayDeviceRevoke(device.deviceId, relayPairing.binding)
      if (createdNewPendingDevice) {
        this.discardPendingMobilePairingDevice(direct.deviceId)
      }
      return this.relayPairingRequestSuperseded()
    }
    try {
      if (!this.setMobileRelayBinding(device.deviceId, relayPairing.binding)) {
        this.queueOrRetainRelayDeviceRevoke(device.deviceId, relayPairing.binding)
        return refuseAutomaticWithoutRelay({
          code: 'relay_binding_failed',
          stage: 'binding_failed',
          message: 'Could not store Relay binding for the pairing device'
        })
      }
    } catch (error) {
      console.warn('[runtime] Failed to persist Relay pairing binding:', error)
      this.queueOrRetainRelayDeviceRevoke(device.deviceId, relayPairing.binding)
      return refuseAutomaticWithoutRelay({
        code: 'relay_binding_failed',
        stage: 'binding_failed',
        message: 'Could not store Relay binding for the pairing device'
      })
    }
    return {
      ...direct,
      connectionMode,
      pairingUrl: encodePairingOffer({
        v: PAIRING_OFFER_VERSION,
        endpoint: direct.endpoint,
        deviceToken: device.token,
        publicKeyB64,
        pairedDeviceId: device.deviceId,
        scope: 'mobile',
        relay: relayPairing.relay
      })
    }
  }

  protected relayPairingRequestSuperseded(): PairingOfferUnavailable {
    return {
      available: false,
      reason: 'relay_mint_failed',
      guidance: 'The Relay pairing request was replaced by a newer connection choice.',
      relayFailure: {
        code: 'relay_request_superseded',
        stage: 'binding_failed',
        message: 'Relay pairing request superseded'
      }
    }
  }

  protected discardPendingMobilePairingDevice(deviceId: string): void {
    const device = this.deviceRegistry?.getDevice(deviceId)
    if (!device || device.scope !== 'mobile' || device.lastSeenAt !== 0) {
      return
    }
    if (device.relayBinding) {
      if (!this.queueRelayDeviceRevoke(device.relayBinding)) {
        return
      }
    }
    try {
      this.deviceRegistry?.removeDevice(deviceId)
    } catch (error) {
      console.error('[runtime] Failed to drop an unused mobile pairing credential:', error)
    }
  }
}
