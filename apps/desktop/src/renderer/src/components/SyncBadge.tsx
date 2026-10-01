import React from 'react'
import { Cloud, CloudOff, Loader2, TriangleAlert } from 'lucide-react'
import type { SyncStatus } from '@shared/cloud'
import { Badge } from '@renderer/components/ui/misc'
import { useCloud } from '@renderer/hooks/useCloud'
import { cn } from '@renderer/lib/utils'

export function syncLabel(status: SyncStatus): { label: string; hint: string } {
  switch (status.phase) {
    case 'disabled':
      return { label: 'Local', hint: 'No account: everything stays on this device' }
    case 'signed-out':
      return { label: 'Signed out', hint: 'Sign in to sync across devices' }
    case 'connecting':
      return { label: 'Connecting', hint: 'Authenticating with your account' }
    case 'syncing':
      return {
        label: `Syncing ${status.pendingOps}`,
        hint: `${status.pendingOps} change${status.pendingOps === 1 ? '' : 's'} waiting to upload`
      }
    case 'synced':
      return { label: 'Synced', hint: 'Everything is up to date' }
    case 'offline':
      return {
        label: 'Offline',
        hint: status.pendingOps
          ? `${status.pendingOps} change${status.pendingOps === 1 ? '' : 's'} will upload when you are back online`
          : 'Working from the copy on this device'
      }
    case 'error':
      return { label: 'Sync issue', hint: status.error ?? 'Retrying shortly' }
  }
}

function SyncIcon({
  status,
  className
}: {
  status: SyncStatus
  className?: string
}): React.JSX.Element {
  const cls = cn('size-3.5', className)
  switch (status.phase) {
    case 'syncing':
    case 'connecting':
      return <Loader2 className={cn(cls, 'animate-spin')} />
    case 'offline':
    case 'signed-out':
    case 'disabled':
      return <CloudOff className={cls} />
    case 'error':
      return <TriangleAlert className={cls} />
    default:
      return <Cloud className={cls} />
  }
}

/** Compact status for page headers: "Synced", "Syncing 2", "Offline"… Hidden in local builds. */
export function SyncBadge({ className }: { className?: string }): React.JSX.Element | null {
  const { enabled, status } = useCloud()
  if (!enabled || !status || status.phase === 'disabled') return null
  const { label, hint } = syncLabel(status)
  const variant =
    status.phase === 'synced'
      ? 'success'
      : status.phase === 'error'
        ? 'destructive'
        : status.phase === 'signed-out' || status.phase === 'offline'
          ? 'outline'
          : 'secondary'
  return (
    <Badge variant={variant} className={cn('h-6 gap-1.5 px-2', className)} title={hint}>
      <SyncIcon status={status} />
      {label}
    </Badge>
  )
}
