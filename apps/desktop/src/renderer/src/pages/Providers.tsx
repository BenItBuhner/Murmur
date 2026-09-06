import React, { useEffect, useMemo, useState } from 'react'
import { ExternalLink, Loader2, Play } from 'lucide-react'
import type { ProviderTestResult } from '@shared/types'
import { STT_PRESETS, findPreset } from '@core/stt/presets'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Switch } from '@renderer/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { Badge } from '@renderer/components/ui/misc'
import { PageHeader, Section, SettingRow } from '@renderer/components/SettingRow'
import { ModelField, SecretInput, TestResult } from '@renderer/components/ProviderForm'
import { LanguageSelect } from '@renderer/components/LanguageSelect'
import { useSettings } from '@renderer/hooks/useSettings'

export function ProvidersPage({
  embedded,
  onReady
}: {
  embedded?: boolean
  onReady?: (ok: boolean) => void
}): React.JSX.Element {
  const { settings, patch } = useSettings()
  const stt = settings.stt
  const preset = findPreset(stt.presetId)
  const [discovered, setDiscovered] = useState<string[] | null>(null)
  const [discovering, setDiscovering] = useState(false)
  const [discoverError, setDiscoverError] = useState<string>()
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<ProviderTestResult | null>(null)

  useEffect(() => {
    setDiscovered(null)
    setDiscoverError(undefined)
    setResult(null)
  }, [stt.baseUrl, stt.kind])

  const choosePreset = async (id: string): Promise<void> => {
    const p = findPreset(id)
    await patch({
      stt: { presetId: p.id, kind: p.kind, baseUrl: p.baseUrl, model: p.defaultModel }
    })
  }

  const discover = async (): Promise<void> => {
    setDiscovering(true)
    setDiscoverError(undefined)
    const r = await window.murmur.stt.listModels()
    setDiscovering(false)
    if (r.ok) {
      setDiscovered(r.models)
      if (!r.models.length)
        setDiscoverError('The server returned an empty model list; type the model id instead.')
    } else setDiscoverError(r.error)
  }

  const test = async (): Promise<void> => {
    setTesting(true)
    setResult(null)
    const r = await window.murmur.stt.test()
    setTesting(false)
    setResult(r)
    onReady?.(r.ok)
  }

  const knownModels = useMemo(() => preset.models, [preset])
  const configured = !!stt.baseUrl && !!stt.model

  return (
    <div className="space-y-8">
      {!embedded && (
        <PageHeader
          title="Models"
          description="Where your audio goes to become text. Everything runs against your own account or your own machine."
        />
      )}

      <Section title="Speech to text">
        <SettingRow
          title="Provider"
          description={
            preset.note ?? 'Pick a preset or point Murmur at any OpenAI-compatible server.'
          }
        >
          <Select value={stt.presetId} onValueChange={(v) => void choosePreset(v)}>
            <SelectTrigger className="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STT_PRESETS.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          title="Base URL"
          description={
            preset.local
              ? 'Your local server. No audio leaves this machine.'
              : 'Include the /v1 path if the server uses one.'
          }
          vertical
        >
          <Input
            value={stt.baseUrl}
            onChange={(e) => void patch({ stt: { baseUrl: e.target.value.trim() } })}
            placeholder="https://api.example.com/v1"
            className="font-mono text-[13px]"
            spellCheck={false}
          />
        </SettingRow>
        <SettingRow
          title="API key"
          description={
            preset.requiresKey
              ? 'Stored encrypted with your OS keychain.'
              : 'Optional for local servers.'
          }
          vertical
        >
          <SecretInput slot="stt" />
        </SettingRow>
        <SettingRow title="Model" vertical>
          <div className="w-full">
            <ModelField
              value={stt.model}
              onChange={(m) => void patch({ stt: { model: m } })}
              known={knownModels}
              discovered={discovered}
              discovering={discovering}
              onDiscover={discover}
              discoverError={discoverError}
              label="Primary model"
            />
          </div>
        </SettingRow>
        <SettingRow
          title="Fallback model"
          description="Tried automatically when the primary model errors or times out."
          vertical
        >
          <div className="w-full">
            <ModelField
              value={stt.fallbackModel}
              onChange={(m) => void patch({ stt: { fallbackModel: m } })}
              known={knownModels.filter((m) => m !== stt.model)}
              discovered={discovered}
              discovering={discovering}
              onDiscover={discover}
              placeholder="none"
              label="Fallback (optional)"
            />
          </div>
        </SettingRow>
        <SettingRow
          title="Test connection"
          description="Transcribes an 11-second built-in clip so you can see real latency before you rely on it."
          vertical
        >
          <div className="flex w-full items-center gap-3">
            <Button onClick={test} disabled={testing || !configured}>
              {testing ? <Loader2 className="animate-spin" /> : <Play />} Run test
            </Button>
            {!configured && (
              <span className="text-[13px] text-muted-foreground">
                Enter a base URL and model first.
              </span>
            )}
            {preset.docsUrl && (
              <Button
                variant="link"
                size="sm"
                className="ml-auto"
                onClick={() => void window.murmur.app.openExternal(preset.docsUrl!)}
              >
                Provider docs <ExternalLink />
              </Button>
            )}
          </div>
          {result && (
            <div className="w-full">
              <TestResult result={result} onPickModel={(m) => void patch({ stt: { model: m } })} />
            </div>
          )}
        </SettingRow>
      </Section>

      <Section title="Recognition">
        <SettingRow
          title="Language"
          description="Locks the speech model to one language: faster, more accurate, and no surprise switches on unclear words. The formatting model is told the same language. Auto-detect handles code-switching."
        >
          <LanguageSelect />
        </SettingRow>
        <SettingRow
          title="Bias with dictionary"
          description="Sends your dictionary and snippet triggers as a prompt so rare words are spelled right the first time."
        >
          <Switch
            checked={stt.useDictionaryPrompt}
            onCheckedChange={(v) => void patch({ stt: { useDictionaryPrompt: v } })}
          />
        </SettingRow>
        <SettingRow title="Timeout" description="Give up on a transcription after this long.">
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={2}
              max={120}
              className="w-20 text-right"
              value={Math.round(stt.timeoutMs / 1000)}
              onChange={(e) =>
                void patch({ stt: { timeoutMs: Math.max(2000, Number(e.target.value) * 1000) } })
              }
            />
            <span className="text-sm text-muted-foreground">s</span>
          </div>
        </SettingRow>
      </Section>

      {!embedded && (
        <div className="flex flex-wrap gap-2 text-[12px] text-muted-foreground">
          <Badge variant="outline">{stt.kind}</Badge>
          {stt.model && <Badge variant="outline">{stt.model}</Badge>}
          {preset.local && <Badge variant="success">local</Badge>}
        </div>
      )}
    </div>
  )
}
