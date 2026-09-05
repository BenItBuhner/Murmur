import React, { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, Loader2, XCircle } from 'lucide-react'
import type { ProviderTestResult } from '@shared/types'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { Badge } from '@renderer/components/ui/misc'
import { cn } from '@renderer/lib/utils'

export interface ModelFieldProps {
  value: string
  onChange: (v: string) => void
  known: string[]
  discovered: string[] | null
  discovering: boolean
  onDiscover: () => void
  discoverError?: string
  placeholder?: string
  label?: string
}

/** Model picker that accepts discovered ids, preset suggestions, or anything typed by hand. */
export function ModelField({
  value,
  onChange,
  known,
  discovered,
  discovering,
  onDiscover,
  discoverError,
  placeholder,
  label = 'Model'
}: ModelFieldProps): React.JSX.Element {
  const options = useMemo(() => {
    const set = new Set<string>()
    for (const m of discovered ?? []) set.add(m)
    for (const m of known) set.add(m)
    if (value) set.add(value)
    return [...set]
  }, [discovered, known, value])
  const [custom, setCustom] = useState(false)

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label>{label}</Label>
        <button
          type="button"
          className="text-[12px] text-muted-foreground hover:text-foreground"
          onClick={() => setCustom((c) => !c)}
        >
          {custom ? 'Choose from list' : 'Type a model id'}
        </button>
      </div>
      <div className="flex gap-2">
        {custom ? (
          <Input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder ?? 'model-id'}
            className="font-mono text-[13px]"
          />
        ) : (
          <Select value={value || undefined} onValueChange={onChange}>
            <SelectTrigger className="w-full font-mono text-[13px]">
              <SelectValue placeholder={placeholder ?? 'Select a model'} />
            </SelectTrigger>
            <SelectContent>
              {options.map((m) => (
                <SelectItem key={m} value={m} className="font-mono text-[13px]">
                  {m}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Button
          variant="outline"
          onClick={onDiscover}
          disabled={discovering}
          title="Fetch the model list from the server"
        >
          Discover
        </Button>
      </div>
      {discoverError && <p className="text-[12px] text-destructive">{discoverError}</p>}
      {discovered && !discoverError && (
        <p className="text-[12px] text-muted-foreground">
          {discovered.length} models found on the server; speech models are listed first.
        </p>
      )}
    </div>
  )
}

export function TestResult({
  result,
  onPickModel
}: {
  result: ProviderTestResult | null
  onPickModel?: (m: string) => void
}): React.JSX.Element | null {
  if (!result) return null
  return (
    <div
      className={cn(
        'rounded-lg border px-3 py-2.5 text-[13px] animate-fade-in',
        result.ok ? 'border-success/40 bg-success/5' : 'border-destructive/40 bg-destructive/5'
      )}
    >
      <div className="flex items-start gap-2">
        {result.ok ? (
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
        ) : (
          <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
        )}
        <div className="min-w-0 flex-1">
          <div>{result.message}</div>
          {result.text && (
            <div className="mt-1 truncate text-muted-foreground">“{result.text}”</div>
          )}
          {result.suggestedModels && result.suggestedModels.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="text-muted-foreground">Server offers:</span>
              {result.suggestedModels.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => onPickModel?.(m)}
                  className="rounded-md border bg-card px-1.5 py-0.5 font-mono text-[12px] hover:bg-accent"
                >
                  {m}
                </button>
              ))}
            </div>
          )}
        </div>
        {result.latencyMs !== undefined && <Badge variant="secondary">{result.latencyMs} ms</Badge>}
      </div>
    </div>
  )
}

/** Password-style input that only writes to the encrypted store on blur / Enter. */
export function SecretInput({
  slot,
  placeholder,
  onSaved
}: {
  slot: 'stt' | 'llm'
  placeholder?: string
  onSaved?: (value: string) => void
}): React.JSX.Element {
  const [has, setHas] = useState(false)
  const [value, setValue] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    void window.murmur.secrets.has(slot).then(setHas)
  }, [slot])
  const save = async (): Promise<void> => {
    if (!dirty) return
    setSaving(true)
    await window.murmur.secrets.set(slot, value.trim())
    setHas(!!value.trim())
    setDirty(false)
    setSaving(false)
    onSaved?.(value.trim())
    setValue('')
  }
  return (
    <div className="flex items-center gap-2">
      <Input
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder={has && !dirty ? '••••••••••••  (saved)' : (placeholder ?? 'sk-…')}
        onChange={(e) => {
          setValue(e.target.value)
          setDirty(true)
        }}
        onBlur={() => void save()}
        onKeyDown={(e) => e.key === 'Enter' && void save()}
        className="font-mono text-[13px]"
      />
      {saving && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
      {has && !dirty && !saving && <CheckCircle2 className="size-4 text-success" />}
    </div>
  )
}
