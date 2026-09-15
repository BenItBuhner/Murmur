import React from 'react'
import { chordLabel, type KeyPlatform } from '@core/hotkey/keys'
import { cn } from '@renderer/lib/utils'

export function platformFor(p: string | undefined): KeyPlatform {
  return p === 'win32' ? 'win32' : p === 'darwin' ? 'darwin' : 'linux'
}

/** Key caps for a chord. The large size steps its radius up one notch with its height. */
export function KeyCaps({
  keys,
  platform,
  sideSensitive,
  size = 'md',
  className
}: {
  keys: number[]
  platform: KeyPlatform
  sideSensitive?: boolean
  size?: 'sm' | 'md' | 'lg'
  className?: string
}): React.JSX.Element {
  if (!keys.length) return <span className="text-sm text-muted-foreground">Not set</span>
  const parts = chordLabel(keys, platform, sideSensitive).split(' + ')
  return (
    <span className={cn('inline-flex items-center gap-1', className)}>
      {parts.map((p, i) => (
        <React.Fragment key={i}>
          <kbd
            className={cn(
              size === 'lg' && 'h-9 min-w-9 rounded-sm px-2.5 text-note',
              size === 'sm' && 'h-5 min-w-5 px-1 text-caption'
            )}
          >
            {p}
          </kbd>
          {i < parts.length - 1 && <span className="text-xs text-muted-foreground/60">+</span>}
        </React.Fragment>
      ))}
    </span>
  )
}
