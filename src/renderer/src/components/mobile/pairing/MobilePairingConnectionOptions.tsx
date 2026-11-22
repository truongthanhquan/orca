import { useRef } from 'react'
import { Badge } from '../../ui/badge'
import { translate } from '../../../i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { useAppStore } from '../../../store/index'
import { useOrcaProfileAuthStatusRefresh } from '@/components/orca-profiles/use-orca-profile-auth-status-refresh'
import { cn } from '@/lib/class-names'
import type { MobileRelayStatus } from '../../../../../shared/remote-runtime/relay/mobile-relay-status'
import type { MobilePairingConnectionMode } from '../../../../../shared/remote-runtime/pairing/mobile-pairing-connection-mode'
import { MobilePairingPathOption } from './MobilePairingPathOption'
import { MobileRelaySignInPanel } from './MobileRelaySignInPanel'
import { relayClockSkewMessage } from '../relay-clock-skew-message'
import { useMobileRelayStatus } from '../use-mobile-relay-status'

function relayStatusLabel(status: MobileRelayStatus, t: Translate = translate): string {
  if (status === 'registered') {
    return t('auto.components.settings.MobilePairingConnectionOptions.ready', 'Ready')
  }
  if (status === 'connecting') {
    return t('auto.components.settings.MobilePairingConnectionOptions.connecting', 'Connecting')
  }
  if (status === 'standby') {
    return t('auto.components.settings.MobilePairingConnectionOptions.available', 'Available')
  }
  if (status === 'draining') {
    return t('auto.components.settings.MobilePairingConnectionOptions.reconnecting', 'Reconnecting')
  }
  return t('auto.components.settings.MobilePairingConnectionOptions.unavailable', 'Unavailable')
}

// Show the landed Relay cell for support; the scheme offers no actionable detail.
function relayCellLabel(cellUrl: string): string | null {
  try {
    return new URL(cellUrl).host || null
  } catch {
    return null
  }
}

export function MobilePairingConnectionOptions({
  value,
  onChange,
  compact = false,
  relayMintFailed = false,
  relayMintRetrying = false
}: {
  value: MobilePairingConnectionMode
  onChange: (value: MobilePairingConnectionMode) => void
  compact?: boolean
  /** When true, show Unavailable on the Relay row (mint failed; no QR). */
  relayMintFailed?: boolean
  relayMintRetrying?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const cloudflareRelayUrl =
    useAppStore((state) => state.settings?.mobilePairingCloudflareRelayUrl) ?? ''
  const updateSettings = useAppStore((state) => state.updateSettings)
  const authStatus = useAppStore((state) => state.orcaProfileAuthStatus)
  const relayStatus = useMobileRelayStatus()
  const signedIn = authStatus?.state === 'connected'
  const reconnectRequired = authStatus?.state === 'reconnect-required'
  // Unconfigured builds have no Relay sign-in endpoint; mark unavailable instead of offering a dead CTA.
  const configured = authStatus?.configured !== false
  const needsSignIn = value === 'automatic' && !signedIn && configured
  // Availability is a property of the build, not of the current selection.
  const relayUnavailable = !signedIn && !configured
  const relayDisabled = relayMintRetrying || relayUnavailable
  const optionRefs = useRef<Record<MobilePairingConnectionMode, HTMLDivElement | null>>({
    automatic: null,
    'local-only': null,
    'cloudflare-relay': null
  })

  // Wrap/focus radio arrow navigation, but leave nested Sign in controls’ arrows untouched.
  const handleArrowKeys = (event: React.KeyboardEvent): void => {
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
      return
    }
    const target = event.target
    if (!(target instanceof HTMLElement) || target.getAttribute('role') !== 'radio') {
      return
    }
    if (relayDisabled && value !== 'automatic') {
      return
    }
    event.preventDefault()
    const modes: MobilePairingConnectionMode[] = relayDisabled
      ? ['local-only', 'cloudflare-relay']
      : ['automatic', 'cloudflare-relay', 'local-only']
    const index = modes.indexOf(value)
    const next =
      modes[
        (index +
          (event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1) +
          modes.length) %
          modes.length
      ]
    onChange(next)
    optionRefs.current[next]?.focus()
  }

  const relayCell = relayStatus.cellUrl ? relayCellLabel(relayStatus.cellUrl) : null

  useOrcaProfileAuthStatusRefresh()

  return (
    <div className={cn('space-y-2', compact && 'space-y-1.5')}>
      <div
        role="radiogroup"
        aria-label={t(
          'auto.components.settings.MobilePairingConnectionOptions.pathGroup',
          'How the phone reaches this computer'
        )}
        onKeyDown={handleArrowKeys}
        className="overflow-hidden rounded-md border border-border"
      >
        <MobilePairingPathOption
          selected={value === 'automatic'}
          tabIndex={value === 'automatic' && !relayDisabled ? 0 : -1}
          disabled={relayDisabled}
          positionInSet={1}
          setSize={3}
          optionRef={(el) => {
            optionRefs.current.automatic = el
          }}
          onSelect={() => onChange('automatic')}
          title={t(
            'auto.components.settings.MobilePairingConnectionOptions.anywhereTitle',
            'Orca Relay'
          )}
          description={
            relayUnavailable
              ? t(
                  'auto.components.settings.MobilePairingConnectionOptions.relayUnavailable',
                  'Orca Relay isn’t available in this build. Use LAN.'
                )
              : t(
                  'auto.components.settings.MobilePairingConnectionOptions.anywhereDescription',
                  'Phone can be on cellular or any Wi‑Fi. Sign-in required for Relay only.'
                )
          }
          trailing={
            relayUnavailable ? (
              <Badge variant="outline" className="text-[11px]">
                {t(
                  'auto.components.settings.MobilePairingConnectionOptions.unavailable',
                  'Unavailable'
                )}
              </Badge>
            ) : signedIn && value === 'automatic' ? (
              <Badge variant="outline" className="text-[11px]">
                {relayMintRetrying
                  ? t(
                      'auto.components.settings.MobilePairingConnectionOptions.retrying',
                      'Retrying'
                    )
                  : relayMintFailed
                    ? t(
                        'auto.components.settings.MobilePairingConnectionOptions.unavailable',
                        'Unavailable'
                      )
                    : relayStatusLabel(relayStatus.status, t)}
              </Badge>
            ) : null
          }
        />
        {needsSignIn ? <MobileRelaySignInPanel reconnectRequired={reconnectRequired} /> : null}
        {signedIn &&
        value === 'automatic' &&
        !relayMintFailed &&
        relayStatus.clockOffsetMs !== undefined ? (
          <p className="border-t border-border/60 px-3 py-2 text-xs text-destructive" role="alert">
            {relayClockSkewMessage(relayStatus.clockOffsetMs, t)}
          </p>
        ) : null}
        {value === 'automatic' && relayCell ? (
          <p
            className="border-t border-border/60 py-2 pl-10 pr-3 text-xs text-muted-foreground"
            data-testid="relay-cell-line"
          >
            {t('auto.components.settings.MobilePairingConnectionOptions.relayCell', 'Relay cell')}
            {`: ${relayCell}`}
          </p>
        ) : null}
        <div className="border-t border-border" />
        <MobilePairingPathOption
          selected={value === 'cloudflare-relay'}
          tabIndex={value === 'cloudflare-relay' ? 0 : -1}
          positionInSet={2}
          setSize={3}
          optionRef={(el) => {
            optionRefs.current['cloudflare-relay'] = el
          }}
          onSelect={() => onChange('cloudflare-relay')}
          title={t(
            'auto.components.settings.MobilePairingConnectionOptions.cloudflareTitle',
            'My Cloudflare Relay'
          )}
          description={t(
            'auto.components.settings.MobilePairingConnectionOptions.cloudflareDescription',
            'Phone connects through your own Cloudflare Worker relay. HTTPS/WSS access and the matching Postgres/JWT setup are required.'
          )}
          trailing={
            value === 'cloudflare-relay' ? (
              <Badge variant="outline" className="text-[11px]">
                {t(
                  'auto.components.settings.MobilePairingConnectionOptions.cloudflareBadge',
                  'Self-hosted'
                )}
              </Badge>
            ) : null
          }
        />
        {value === 'cloudflare-relay' ? (
          <div className="border-t border-border/60 px-3 py-3">
            <label className="mb-1 block text-xs font-medium" htmlFor="cloudflare-relay-url">
              {t(
                'auto.components.settings.MobilePairingConnectionOptions.cloudflareUrlLabel',
                'Relay director hostname'
              )}
            </label>
            <input
              id="cloudflare-relay-url"
              value={cloudflareRelayUrl}
              onChange={(event) =>
                void updateSettings({
                  mobilePairingCloudflareRelayUrl: event.target.value.trim() || null
                })
              }
              placeholder={t(
                'auto.components.settings.MobilePairingConnectionOptions.cloudflareUrlPlaceholder',
                'https://relay.example.com'
              )}
              className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm"
            />
            <p className="mt-2 text-xs text-muted-foreground">
              {t(
                'auto.components.settings.MobilePairingConnectionOptions.cloudflareUrlHint',
                'Use the Cloudflare URL shown in setup. Do not enter a local IP or a Worker route ending in /v1/connect.'
              )}
            </p>
          </div>
        ) : null}
        <div className="border-t border-border" />
        <MobilePairingPathOption
          selected={value === 'local-only'}
          tabIndex={value === 'local-only' || relayDisabled ? 0 : -1}
          positionInSet={3}
          setSize={3}
          optionRef={(el) => {
            optionRefs.current['local-only'] = el
          }}
          onSelect={() => onChange('local-only')}
          title={t('auto.components.settings.MobilePairingConnectionOptions.localTitle', 'LAN')}
          description={t(
            'auto.components.settings.MobilePairingConnectionOptions.localDescription',
            'Phone must be on this Wi‑Fi or connected through Tailscale. No account needed.'
          )}
        />
      </div>
    </div>
  )
}
