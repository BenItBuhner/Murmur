import React from 'react'
import { chordLabel, type KeyPlatform } from '@core/hotkey/keys'
import { cn } from '@renderer/lib/utils'

export function platformFor(p: string | undefined): KeyPlatform {
  return p === 'win32' ? 'win32' : p === 'darwin' ? 'darwin' : 'linux'
}

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
              size === 'lg' && 'h-9 min-w-9 px-2.5 text-[13px] rounded-lg',
              size === 'sm' && 'h-5 min-w-5 px-1 text-[10px]'
            )}
          >
            {p}
          </kbd>
          {i < parts.length - 1 && <span className="text-muted-foreground/60 text-xs">+</span>}
        </React.Fragment>
      ))}
    </span>
  )
}
