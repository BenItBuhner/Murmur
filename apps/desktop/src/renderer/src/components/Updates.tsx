import React from 'react'
import {
  ArrowRight,
  Download,
  ExternalLink,
  FolderOpen,
  Loader2,
  RefreshCw,
  RotateCw,
  X
} from 'lucide-react'
import { describeInstallKind, kindCanSelfUpdate, type UpdateStatus } from '@shared/updates'
import { Button } from '@renderer/components/ui/button'
import { Badge, Banner } from '@renderer/components/ui/misc'
import { Switch } from '@renderer/components/ui/switch'
import { Appear } from '@renderer/components/motion'
import { Section, SettingRow } from '@renderer/components/SettingRow'
import { useSettings } from '@renderer/hooks/useSettings'
import { useUpdates } from '@renderer/hooks/useUpdates'
import { formatRelative } from '@renderer/lib/utils'
import type { Route } from '@renderer/components/Shell'

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB'
  const mb = bytes / (1024 * 1024)
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`
  return `${mb >= 100 ? mb.toFixed(0) : mb.toFixed(1)} MB`
}

function releaseMeta(status: UpdateStatus): string {
  const release = status.release
  if (!release) return ''
  const parts: string[] = []
  if (release.publishedAt) {
    parts.push(
      `Released ${new Date(release.publishedAt).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric'
      })}`
    )
  }
  if (release.asset) parts.push(formatBytes(release.asset.size))
  return parts.join(' · ')
}

/** Why a downloaded file will not be installed automatically. */
function manualReason(status: UpdateStatus): string {
  const kind = status.installKind
  if (kind === 'dev') return 'Development builds are not updated in place.'
  if (kind === 'portable') {
    return 'Quit Murmur and replace your portable Murmur.exe with the downloaded file.'
  }
  if (!kindCanSelfUpdate(kind)) {
    return `This ${describeInstallKind(kind)} copy cannot replace itself; run the downloaded file to update.`
  }
  if (status.release && !status.release.sha256) {
    return 'This release ships no SHA256SUMS.txt, so Murmur will not install it unattended. Check it and run it yourself.'
  }
  return 'Run the downloaded file to update.'
}

interface Presentation {
  title: React.ReactNode
  description: React.ReactNode
  actions: React.ReactNode
}

function present(status: UpdateStatus, api: ReturnType<typeof useUpdates>): Presentation {
  const v = status.currentVersion
  const release = status.release
  const checkButton = (label = 'Check for updates'): React.ReactNode => (
    <Button
      variant="outline"
      size="sm"
      onClick={() => void api.check()}
      disabled={status.phase === 'checking'}
    >
      {status.phase === 'checking' ? <Loader2 className="animate-spin" /> : <RefreshCw />} {label}
    </Button>
  )
  const notesButton = (
    <Button variant="ghost" size="sm" onClick={() => void api.openReleases()}>
      <ExternalLink /> Release notes
    </Button>
  )
  const skipButton = (
    <Button variant="ghost" size="sm" onClick={() => void api.skip()}>
      Skip this version
    </Button>
  )
  const withPre = (text: string): React.ReactNode => (
    <span className="flex items-center gap-2">
      {text}
      {release?.prerelease && <Badge variant="secondary">Pre-release</Badge>}
    </span>
  )
  const checked = status.lastCheckedAt ? `Checked ${formatRelative(status.lastCheckedAt)}` : ''

  switch (status.phase) {
    case 'checking':
      return {
        title: `Murmur ${v}`,
        description: 'Checking GitHub for new releases…',
        actions: checkButton()
      }
    case 'up-to-date':
      return {
        title: `Murmur ${v} is up to date`,
        description: checked,
        actions: checkButton()
      }
    case 'available':
      if (!release) break
      return {
        title: withPre(`Murmur ${release.version} is available`),
        description: release.asset
          ? releaseMeta(status)
          : 'This release has no download for your platform yet. Open the release page for details.',
        actions: (
          <>
            {skipButton}
            {notesButton}
            {release.asset && (
              <Button size="sm" onClick={() => void api.download()}>
                <Download /> Download
              </Button>
            )}
          </>
        )
      }
    case 'downloading': {
      if (!release) break
      const p = status.progress
      const detail = p
        ? `${Math.floor(p.percent)}% · ${formatBytes(p.transferred)} of ${formatBytes(p.total)}${
            p.bytesPerSecond > 0 ? ` · ${formatBytes(p.bytesPerSecond)}/s` : ''
          }`
        : 'Starting download…'
      return {
        title: withPre(`Downloading Murmur ${release.version}…`),
        description: detail,
        actions: (
          <Button variant="ghost" size="sm" onClick={() => void api.cancelDownload()}>
            <X /> Cancel
          </Button>
        )
      }
    }
    case 'ready':
      if (!release) break
      if (status.canInstall) {
        return {
          title: withPre(`Murmur ${release.version} is ready to install`),
          description: status.waitingForIdle
            ? 'Installing automatically as soon as you finish dictating.'
            : 'Murmur restarts to finish the update; it takes a few seconds.',
          actions: (
            <>
              {skipButton}
              {notesButton}
              <Button size="sm" onClick={() => void api.install()}>
                <RotateCw /> Install and restart
              </Button>
            </>
          )
        }
      }
      return {
        title: withPre(`Murmur ${release.version} downloaded`),
        description: manualReason(status),
        actions: (
          <>
            {skipButton}
            {notesButton}
            <Button size="sm" variant="outline" onClick={() => void api.reveal()}>
              <FolderOpen /> Show in folder
            </Button>
          </>
        )
      }
    case 'installing':
      return {
        title: `Installing Murmur ${release?.version ?? ''}…`,
        description: 'Murmur will restart in a moment.',
        actions: <Loader2 className="size-4 animate-spin text-muted-foreground" />
      }
    case 'error':
      return {
        title: `Murmur ${v}`,
        description: <span className="text-destructive">{status.error}</span>,
        actions: release?.asset ? (
          <Button variant="outline" size="sm" onClick={() => void api.download()}>
            <Download /> Retry download
          </Button>
        ) : (
          checkButton('Try again')
        )
      }
    default:
      break
  }
  return {
    title: `Murmur ${v}`,
    description: checked || 'Not checked yet.',
    actions: checkButton()
  }
}

/** The Updates block on the General page: current state, actions, and the three preferences. */
export function UpdatesSection(): React.JSX.Element {
  const { settings, patch } = useSettings()
  const api = useUpdates()
  const status = api.status
  const prefs = settings.updates
  const kind = status?.installKind ?? 'unknown'
  const selfUpdating = kindCanSelfUpdate(kind)
  const view = status ? present(status, api) : null

  return (
    <Section
      title="Updates"
      description="New versions are published as GitHub Releases. Murmur fetches the build for this install and verifies it against the release checksums."
    >
      {view && (
        <SettingRow
          title={view.title}
          description={
            <>
              {view.description}
              {status?.error && status.phase !== 'error' && (
                <span className="mt-1 block text-destructive">{status.error}</span>
              )}
            </>
          }
        >
          {view.actions}
        </SettingRow>
      )}
      {status?.phase === 'downloading' && (
        <div className="py-3">
          <ProgressBar percent={status.progress?.percent ?? 0} />
        </div>
      )}
      <SettingRow
        title="Check automatically"
        description="Look for new releases when Murmur starts and every few hours."
      >
        <Switch
          checked={prefs.autoCheck}
          onCheckedChange={(v) => void patch({ updates: { autoCheck: v } })}
        />
      </SettingRow>
      <SettingRow
        title={selfUpdating ? 'Install automatically' : 'Download automatically'}
        description={
          selfUpdating
            ? 'Downloads new versions in the background and restarts Murmur once you are not dictating. Turn this off to be asked first.'
            : kind === 'dev'
              ? 'Development builds only download updates; nothing is replaced.'
              : `${describeInstallKind(kind)} copies cannot replace themselves, so the new build is downloaded for you to install.`
        }
      >
        <Switch
          checked={prefs.autoInstall}
          onCheckedChange={(v) => void patch({ updates: { autoInstall: v } })}
        />
      </SettingRow>
      <SettingRow
        title="Include pre-releases"
        description="Offer beta builds (vX.Y.Z-beta.N) as well as stable releases."
      >
        <Switch
          checked={prefs.includePrereleases}
          onCheckedChange={(v) => void patch({ updates: { includePrereleases: v } })}
        />
      </SettingRow>
    </Section>
  )
}

function ProgressBar({ percent }: { percent: number }): React.JSX.Element {
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percent)}
      className="well h-1.5 w-full overflow-hidden rounded-full"
    >
      <div
        className="h-full rounded-full bg-primary transition-[width] duration-200"
        style={{ width: `${Math.max(0, Math.min(100, percent))}%` }}
      />
    </div>
  )
}

/** Home page card while an update is available, downloading or ready; folds in and out. */
export function UpdateBanner({
  onNavigate
}: {
  onNavigate: (r: Route) => void
}): React.JSX.Element {
  const api = useUpdates()
  const status = api.status
  const release = status?.release
  const visible =
    !!status &&
    !!release &&
    (status.phase === 'available' || status.phase === 'downloading' || status.phase === 'ready')
  return (
    <Appear show={visible}>
      {visible && <UpdateCard status={status} onNavigate={onNavigate} />}
    </Appear>
  )
}

function UpdateCard({
  status,
  onNavigate
}: {
  status: UpdateStatus
  onNavigate: (r: Route) => void
}): React.JSX.Element | null {
  const api = useUpdates()
  const release = status.release
  if (!release) return null

  let title = `Murmur ${release.version} is available`
  let detail: string = releaseMeta(status)
  let action: React.ReactNode = release.asset ? (
    <Button onClick={() => void api.download()}>
      <Download /> Download
    </Button>
  ) : (
    <Button variant="outline" onClick={() => void api.openReleases()}>
      <ExternalLink /> View release
    </Button>
  )
  if (status.phase === 'downloading') {
    title = `Downloading Murmur ${release.version}…`
    detail = `${Math.floor(status.progress?.percent ?? 0)}%`
    action = null
  } else if (status.phase === 'ready') {
    if (status.canInstall) {
      title = `Murmur ${release.version} is ready to install`
      detail = status.waitingForIdle
        ? 'It installs automatically once you finish dictating.'
        : 'Murmur restarts to finish the update.'
      action = (
        <Button onClick={() => void api.install()}>
          <RotateCw /> Install and restart
        </Button>
      )
    } else {
      title = `Murmur ${release.version} downloaded`
      detail = manualReason(status)
      action = (
        <Button variant="outline" onClick={() => void api.reveal()}>
          <FolderOpen /> Show in folder
        </Button>
      )
    }
  }

  return (
    <Banner tone="primary" className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-sm font-medium">
          {title}
          {release.prerelease && <Badge variant="secondary">Pre-release</Badge>}
        </div>
        <div className="text-note text-muted-foreground">{detail}</div>
        {status.phase === 'downloading' && (
          <div className="mt-2 w-64">
            <ProgressBar percent={status.progress?.percent ?? 0} />
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button variant="ghost" onClick={() => onNavigate('general')}>
          Details <ArrowRight />
        </Button>
        {action}
      </div>
    </Banner>
  )
}
