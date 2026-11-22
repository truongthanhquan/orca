import type { WslHostRuntimeAccess } from '../../wsl/host-lifecycle/wsl-host-server-stop'
import { isRemoteRuntimeConnectionReady } from '../runtime-environments/connections/runtime-environment-request-connections'
import { callRuntimeEnvironment } from '../runtime-environments/requests/runtime-environment-transport-routing'
import { requestOrcadTerminalCensus } from '../../managed-server/lifecycle/orcad-terminal-census-client'
import { resolveEnvironment } from '../../../shared/remote-runtime/host-store/runtime-environment-store'
import { getPreferredPairedRuntimeConnection } from '../../../shared/remote-runtime/host-catalog/runtime-environments'

export function wslHostRuntimeAccess(getUserDataPath: () => string): WslHostRuntimeAccess {
  return {
    isReady: async (environmentId) =>
      isRemoteRuntimeConnectionReady(
        environmentId,
        getPreferredPairedRuntimeConnection(
          await resolveEnvironment(getUserDataPath(), environmentId)
        )
      ),
    call: async (environmentId, method, params) => {
      const response = await callRuntimeEnvironment(
        getUserDataPath(),
        environmentId,
        method,
        params
      )
      if (!response.ok) {
        throw new Error(response.error.message)
      }
      return response.result
    },
    census: async (environmentId) =>
      requestOrcadTerminalCensus(
        getPreferredPairedRuntimeConnection(
          await resolveEnvironment(getUserDataPath(), environmentId)
        ),
        0
      )
  }
}
