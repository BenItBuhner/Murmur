import React from 'react'
import { LANGUAGE_OPTIONS, languageLabel } from '@shared/languages'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { useSettings } from '@renderer/hooks/useSettings'
import { cn } from '@renderer/lib/utils'

/**
 * Picker for the dictation language (`settings.stt.language`). One setting feeds both the speech
 * model and the formatting model, so the same control appears wherever either is configured.
 */
export function LanguageSelect({ className }: { className?: string }): React.JSX.Element {
  const { settings, patch } = useSettings()
  const value = settings.stt.language
  const known = LANGUAGE_OPTIONS.some((l) => l.code === value)
  return (
    <Select value={value} onValueChange={(v) => void patch({ stt: { language: v } })}>
      <SelectTrigger className={cn('w-44', className)} aria-label="Dictation language">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {!known && <SelectItem value={value}>{languageLabel(value)}</SelectItem>}
        {LANGUAGE_OPTIONS.map((l) => (
          <SelectItem key={l.code} value={l.code}>
            {l.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
