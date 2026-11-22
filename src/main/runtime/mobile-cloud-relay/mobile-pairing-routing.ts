import type { OrcaRuntimeRpcServer } from '../rpc/server/runtime-rpc'
import type {
  PairingGetEndpointsParams,
  PairingGetEndpointsResult,
  PairingProvisionRelayParams,
  DeviceCredentialInstalled
} from '../../../shared/remote-runtime/relay/mobile-relay-credential-contract'
import type { MobilePairingConnectionContext } from '../rpc/server/runtime-rpc-pairing-types'
import type { RelaySessionBroker } from './session-lifecycle/relay-session-broker'
import { canonicalMobilePairingCloudflareRelayUrl } from '../../../shared/remote-runtime/pairing/mobile-pairing-connection-mode'
import { customRelayEndpoints, provisionCustomRelay } from './custom-relay-broker'
import { pairingAuthorizationForContext } from './pairing/relay-pairing-authorization'

export async function getCustomMobileRelayEndpoints(args: {
  runtimeRpc: OrcaRuntimeRpcServer
  context: MobilePairingConnectionContext
  params: PairingGetEndpointsParams
  requireCustomBroker: (url: string) => Promise<RelaySessionBroker>
  requireActiveBroker: (waitMs: number) => Promise<RelaySessionBroker>
  withTransientDemand: <T>(key: string, operation: () => Promise<T>) => Promise<T>
  assertRelayHost: (context: MobilePairingConnectionContext, broker: RelaySessionBroker) => void
}): Promise<PairingGetEndpointsResult | null> {
  const mode = args.runtimeRpc
    .getDeviceRegistry()
    ?.getMobilePairingConnectionMode(args.context.deviceId)
  if (mode === 'cloudflare-relay') {
    const url = canonicalMobilePairingCloudflareRelayUrl(
      args.runtimeRpc.requireStore().getSettings().mobilePairingCloudflareRelayUrl
    )
    if (url === null) {
      return { v: 1, relay: null }
    }
    return await args.withTransientDemand(`endpoints:${args.context.deviceId}`, async () => {
      const broker = await args.requireCustomBroker(url).catch(() => null)
      if (!broker?.endpoint) {
        return { v: 1, relay: null }
      }
      args.assertRelayHost(args.context, broker)
      return customRelayEndpoints(broker, args.context, args.params)
    })
  }
  return null
}

export async function provisionCustomMobileRelay(args: {
  runtimeRpc: OrcaRuntimeRpcServer
  context: MobilePairingConnectionContext
  params: PairingProvisionRelayParams
  requireCustomBroker: (url: string) => Promise<RelaySessionBroker>
  requireActiveBroker: (waitMs: number) => Promise<RelaySessionBroker>
  withTransientDemand: <T>(key: string, operation: () => Promise<T>) => Promise<T>
  assertRelayHost: (context: MobilePairingConnectionContext, broker: RelaySessionBroker) => void
}): Promise<DeviceCredentialInstalled | null> {
  const mode = args.runtimeRpc
    .getDeviceRegistry()
    ?.getMobilePairingConnectionMode(args.context.deviceId)
  if (mode === 'cloudflare-relay') {
    const url = canonicalMobilePairingCloudflareRelayUrl(
      args.runtimeRpc.requireStore().getSettings().mobilePairingCloudflareRelayUrl
    )
    if (url === null) {
      throw new Error('relay_disabled_for_device')
    }
    return await args.withTransientDemand(`provision:${args.context.deviceId}`, async () => {
      const broker = await args.requireCustomBroker(url)
      args.assertRelayHost(args.context, broker)
      return await provisionCustomRelay(broker, args.context, args.params)
    })
  }
  return null
}

export async function routeMobileRelayProvision(args: {
  runtimeRpc: OrcaRuntimeRpcServer
  context: MobilePairingConnectionContext
  params: PairingProvisionRelayParams
  waitMs: number
  requireCustomBroker: (url: string) => Promise<RelaySessionBroker>
  requireActiveBroker: (waitMs: number) => Promise<RelaySessionBroker>
  withTransientDemand: <T>(key: string, operation: () => Promise<T>) => Promise<T>
  assertRelayHost: (context: MobilePairingConnectionContext, broker: RelaySessionBroker) => void
  setRelayBinding: (context: MobilePairingConnectionContext, broker: RelaySessionBroker) => boolean
}): Promise<DeviceCredentialInstalled> {
  const custom = await provisionCustomMobileRelay({
    runtimeRpc: args.runtimeRpc,
    context: args.context,
    params: args.params,
    requireCustomBroker: args.requireCustomBroker,
    withTransientDemand: args.withTransientDemand,
    assertRelayHost: args.assertRelayHost
  })
  if (custom !== null) {
    return custom
  }
  if (
    args.runtimeRpc.getDeviceRegistry()?.getMobilePairingConnectionMode(args.context.deviceId) ===
    'local-only'
  ) {
    throw new Error('relay_disabled_for_device')
  }
  return await args.withTransientDemand(`provision:${args.context.deviceId}`, async () => {
    const broker = await args.requireActiveBroker(args.waitMs)
    if (!broker.endpoint) {
      throw new Error('relay_control_not_active')
    }
    args.assertRelayHost(args.context, broker)
    const authorization = pairingAuthorizationForContext(args.context, broker.hostId)
    if (!authorization) {
      throw new Error('relay_provision_authorization_unavailable')
    }
    if (!args.setRelayBinding(args.context, broker)) {
      throw new Error('mobile_device_not_found')
    }
    return await broker.installCredential(args.context.deviceId, args.params, authorization)
  })
}

export async function routeMobileRelayEndpoints(args: {
  runtimeRpc: OrcaRuntimeRpcServer
  context: MobilePairingConnectionContext
  params: PairingGetEndpointsParams
  waitMs: number
  requireCustomBroker: (url: string) => Promise<RelaySessionBroker>
  requireActiveBroker: (waitMs: number) => Promise<RelaySessionBroker>
  withTransientDemand: <T>(key: string, operation: () => Promise<T>) => Promise<T>
  assertRelayHost: (context: MobilePairingConnectionContext, broker: RelaySessionBroker) => void
}): Promise<PairingGetEndpointsResult> {
  const custom = await getCustomMobileRelayEndpoints({
    runtimeRpc: args.runtimeRpc,
    context: args.context,
    params: args.params,
    requireCustomBroker: args.requireCustomBroker,
    withTransientDemand: args.withTransientDemand,
    assertRelayHost: args.assertRelayHost
  })
  if (custom !== null) {
    return custom
  }
  return await args.withTransientDemand(`endpoints:${args.context.deviceId}`, async () => {
    const broker = await args.requireActiveBroker(args.waitMs).catch(() => null)
    if (!broker?.endpoint) {
      return { v: 1, relay: null }
    }
    args.assertRelayHost(args.context, broker)
    const result: PairingGetEndpointsResult = { v: 1, relay: broker.endpoint }
    if (args.params.installReqId) {
      result.installStatus = broker.credentialInstallStatus(
        args.context.deviceId,
        args.params.installReqId
      )
    }
    return result
  })
}
