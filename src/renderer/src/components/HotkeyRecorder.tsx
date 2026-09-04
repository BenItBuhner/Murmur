import React, { useEffect, useState } from 'react'
import { XIcon } from 'lucide-react'
import type { HotkeyCapture } from '@shared/types'
import { Button } from '@renderer/components/ui/button'
import { KeyCaps } from './KeyCaps'
import type { KeyPlatform } from '@core/hotkey/keys'
import { cn } from '@renderer/lib/utils'

interface Props {
  value: number[]
  onChange: (keys: number[]) => void
  platform: KeyPlatform
  sideSensitive: boolean
  allowClear?: boolean
}

/**
 * Click "Change", press the combination, release all keys. The main process streams what it sees
 * through the global hook so the recorder shows exactly what will be matched later.
 */
export function HotkeyRecorder({
  value,
  onChange,
  platform,
  sideSensitive,
  allowClear
}: Props): React.JSX.Element {
  const [recording, setRecording] = useState(false)
  const [live, setLive] = useState<(HotkeyCapture & { final: boolean }) | null>(null)

  useEffect(() => {
    if (!recording) return
    const unsub = window.murmur.hotkeys.onCaptured((c) => {
      setLive(c)
      if (c.final) {
        setRecording(false)
        if (c.valid && c.keys.length) onChange(c.keys)
        setTimeout(() => setLive(null), c.valid ? 0 : 2500)
      }
    })
    void window.murmur.hotkeys.startCapture()
    return () => {
      unsub()
      void window.murmur.hotkeys.stopCapture()
    }
  }, [recording, onChange])

  return (
    <div className="flex items-center gap-3">
      <div
        className={cn(
          'flex h-10 min-w-44 items-center justify-center rounded-lg border bg-card px-3 transition-colors',
          recording && 'border-record/60 ring-4 ring-record/15',
          live && !live.valid && live.final && 'border-destructive/60'
        )}
      >
        {recording ? (
          live && live.keys.length ? (
            <KeyCaps keys={live.keys} platform={platform} sideSensitive={sideSensitive} />
          ) : (
            <span className="text-sm text-muted-foreground animate-pulse">
              Press your shortcut…
            </span>
          )
        ) : live && !live.valid && live.final ? (
          <span className="text-[12px] text-destructive">{live.reason ?? 'Not allowed'}</span>
        ) : (
          <KeyCaps keys={value} platform={platform} sideSensitive={sideSensitive} />
        )}
      </div>
      {recording ? (
        <Button variant="ghost" size="sm" onClick={() => setRecording(false)}>
          Cancel
        </Button>
      ) : (
        <>
          <Button variant="outline" size="sm" onClick={() => setRecording(true)}>
            Change
          </Button>
          {allowClear && value.length > 0 && (
            <Button
              variant="ghost"
              size="icon-sm"
              title="Remove shortcut"
              onClick={() => onChange([])}
            >
              <XIcon />
            </Button>
          )}
        </>
      )}
    </div>
  )
}
