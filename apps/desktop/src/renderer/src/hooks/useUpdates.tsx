import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import type { UpdateStatus } from '@shared/updates'

interface Ctx {
  status: UpdateStatus | null
  /** Manual check: surfaces the outcome as a toast when nothing is found or it fails. */
  check: () => Promise<void>
  download: () => Promise<void>
  cancelDownload: () => Promise<void>
  install: () => Promise<void>
  skip: () => Promise<void>
  reveal: () => Promise<void>
  openReleases: () => Promise<void>
}

const UpdatesContext = createContext<Ctx | null>(null)

export function UpdatesProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [status, setStatus] = useState<UpdateStatus | null>(null)

  useEffect(() => {
    void window.murmur.updates.status().then(setStatus)
    return window.murmur.updates.onStatus(setStatus)
  }, [])

  // One-time "you're now on X" notice after the app relaunched into a version it installed.
  useEffect(() => {
    if (!status?.updatedFrom) return
    toast.success(`Murmur updated to ${status.currentVersion}`, {
      description: `You were on ${status.updatedFrom}.`,
      duration: 8000
    })
    void window.murmur.updates.ackUpdated()
  }, [status?.updatedFrom, status?.currentVersion])

  const check = useCallback(async () => {
    const result = await window.murmur.updates.check()
    if (result.phase === 'up-to-date') {
      toast.success(`Murmur ${result.currentVersion} is the latest version`)
    } else if (result.phase === 'error' && result.error) {
      toast.error(result.error)
    }
  }, [])

  const value = useMemo<Ctx>(
    () => ({
      status,
      check,
      download: async () => void (await window.murmur.updates.download()),
      cancelDownload: () => window.murmur.updates.cancelDownload(),
      install: async () => void (await window.murmur.updates.install()),
      skip: async () => void (await window.murmur.updates.skip()),
      reveal: () => window.murmur.updates.reveal(),
      openReleases: () => window.murmur.updates.openReleases()
    }),
    [status, check]
  )
  return <UpdatesContext.Provider value={value}>{children}</UpdatesContext.Provider>
}

export function useUpdates(): Ctx {
  const ctx = useContext(UpdatesContext)
  if (!ctx) throw new Error('useUpdates outside provider')
  return ctx
}
