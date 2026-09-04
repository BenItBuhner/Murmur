import React, { useEffect, useState } from 'react'
import { Loader2, Play, Plus, Trash2 } from 'lucide-react'
import type { AppRule, FormattingMode, Tone } from '@shared/settings'
import type { ProviderTestResult } from '@shared/types'
import { LLM_PRESETS } from '@core/stt/presets'
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
import { Segmented } from '@renderer/components/ui/misc'
import { PageHeader, Section, SettingRow } from '@renderer/components/SettingRow'
import { ModelField, SecretInput, TestResult } from '@renderer/components/ProviderForm'
import { useSettings } from '@renderer/hooks/useSettings'
import { uid } from '@renderer/lib/utils'

const TONES: Array<{ value: Tone; label: string; hint: string }> = [
  {
    value: 'auto',
    label: 'Auto',
    hint: 'Casual in chat apps, professional in email and documents'
  },
  { value: 'casual', label: 'Casual', hint: 'Relaxed, contractions, fragments are fine' },
  { value: 'neutral', label: 'Neutral', hint: 'Clean sentences, faithful to how you talk' },
  { value: 'professional', label: 'Professional', hint: 'Complete sentences, no slang' }
  }
]

export function StylePage(): React.JSX.Element {
  const { settings, patch } = useSettings()
  const f = settings.formatting
  const [fillers, setFillers] = useState(f.fillerWords.join(', '))
  const [discovered, setDiscovered] = useState<string[] | null>(null)
  const [discovering, setDiscovering] = useState(false)
  const [discoverError, setDiscoverError] = useState<string>()
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<ProviderTestResult | null>(null)
  const [llmPreset, setLlmPreset] = useState(f.llm.sameAsStt ? 'same' : 'custom')

  useEffect(() => setFillers(f.fillerWords.join(', ')), [f.fillerWords])

  const saveFillers = (): void => {
    const list = [
      ...new Set(
        fillers
          .split(/[,\n]/)
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean)
      )
    ]
    void patch({ formatting: { fillerWords: list } })
  }

  const discover = async (): Promise<void> => {
    setDiscovering(true)
    setDiscoverError(undefined)
    const r = await window.murmur.llm.listModels()
    setDiscovering(false)
    if (r.ok) setDiscovered(r.models)
    else setDiscoverError(r.error)
  }
  const test = async (): Promise<void> => {
    setTesting(true)
    setResult(null)
    const r = await window.murmur.llm.test()
    setTesting(false)
    setResult(r)
  }
  const choosePreset = (id: string): void => {
    setLlmPreset(id)
    const p = LLM_PRESETS.find((x) => x.id === id)!
    if (id === 'same') void patch({ formatting: { llm: { sameAsStt: true } } })
    else
      void patch({
        formatting: {
          llm: { sameAsStt: false, baseUrl: p.baseUrl, model: p.defaultModel || f.llm.model }
        }
      })
  }

  const addRule = (): void => {
    const rule: AppRule = { id: uid(), match: '', tone: 'auto' }
    void patch({ formatting: { appRules: [...f.appRules, rule] } })
  }
  const updateRule = (id: string, partial: Partial<AppRule>): void => {
    void patch({
      formatting: { appRules: f.appRules.map((r) => (r.id === id ? { ...r, ...partial } : r)) }
    })
  }
  const removeRule = (id: string): void =>
    void patch({ formatting: { appRules: f.appRules.filter((r) => r.id !== id) } })

  return (
    <div className="space-y-8">
      <PageHeader
        title="Style"
        description="How raw speech becomes finished text. Deterministic cleanup always runs; smart formatting adds a small language model on top."
      />

      <Section title="Formatting">
        <SettingRow
          title="Mode"
          description={
            f.mode === 'off'
              ? 'Insert exactly what the speech model heard.'
              : f.mode === 'light'
                ? 'Instant, rule-based: fillers, spoken commands, dictionary, punctuation spacing.'
                : 'Rule-based cleanup, then a language model fixes punctuation, lists, numbers and self-corrections. Falls back to light if the model is slow or misbehaves.'
          }
        >
          <Segmented<FormattingMode>
            value={f.mode}
            onChange={(v) => void patch({ formatting: { mode: v } })}
            options={[
              { value: 'off', label: 'Off' },
              { value: 'light', label: 'Light' },
              { value: 'smart', label: 'Smart' }
            ]}
          />
        </SettingRow>
        <SettingRow title="Tone" description={TONES.find((t) => t.value === f.tone)?.hint}>
          <Segmented<Tone>
            value={f.tone}
            onChange={(v) => void patch({ formatting: { tone: v } })}
            options={TONES.map(({ value, label }) => ({ value, label }))}
          />
        </SettingRow>
        <SettingRow
          title="Remove filler words"
          description="um, uh, hmm and friends disappear; sentence-initial fillers are re-capitalized."
        >
          <Switch
            checked={f.removeFillers}
            onCheckedChange={(v) => void patch({ formatting: { removeFillers: v } })}
          />
        </SettingRow>
        {f.removeFillers && (
          <SettingRow
            title="Filler list"
            description="Comma separated. Whole words only, so "umbrella" is safe."
            vertical
          >
            <Input
              value={fillers}
              onChange={(e) => setFillers(e.target.value)}
              onBlur={saveFillers}
              onKeyDown={(e) => e.key === 'Enter' && saveFillers()}
              className="font-mono text-[13px]"
            />
          </SettingRow>
        )}
        <SettingRow title="Collapse stutters" description=""the the report" becomes "the report".">
          <Switch
            checked={f.collapseRepeats}
            onCheckedChange={(v) => void patch({ formatting: { collapseRepeats: v } })}
          />
        </SettingRow>
        <SettingRow
          title="Self-corrections"
          description=""Tuesday, no, Wednesday" keeps only Wednesday. Smart mode handles the trickier ones."
        >
          <Switch
            checked={f.selfCorrections}
            onCheckedChange={(v) => void patch({ formatting: { selfCorrections: v } })}
          />
        </SettingRow>
        <SettingRow
          title="Spoken commands"
          description=""new line", "new paragraph", "scratch that", "question mark"."
        >
          <Switch
            checked={f.spokenCommands}
            onCheckedChange={(v) => void patch({ formatting: { spokenCommands: v } })}
          />
        </SettingRow>
        <SettingRow
          title=""Press enter" command"
          description="End a dictation with "press enter" or "send it" to submit the message right away."
        >
          <Switch
            checked={f.pressEnterCommand}
            onCheckedChange={(v) => void patch({ formatting: { pressEnterCommand: v } })}
          />
        </SettingRow>
        <SettingRow
          title="Capitalize sentences"
          description="First letter of each sentence, and the pronoun I."
        >
          <Switch
            checked={f.autoCapitalize}
            onCheckedChange={(v) => void patch({ formatting: { autoCapitalize: v } })}
          />
        </SettingRow>
        <SettingRow
          title="Trailing space"
          description="Add a space after each dictation so the next one flows on naturally."
        >
          <Switch
            checked={f.trailingSpace}
            onCheckedChange={(v) => void patch({ formatting: { trailingSpace: v } })}
          />
        </SettingRow>
      </Section>

      <Section
        title="Smart formatting model"
        description="An OpenAI-compatible chat model. Fast small models (Groq Llama 8B, gpt-4o-mini, Cerebras) keep the round-trip under a second."
      >
        <SettingRow title="Server">
          <Select value={llmPreset} onValueChange={choosePreset}>
            <SelectTrigger className="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LLM_PRESETS.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        {!f.llm.sameAsStt && (
          <>
            <SettingRow title="Base URL" vertical>
              <Input
                value={f.llm.baseUrl}
                onChange={(e) =>
                  void patch({ formatting: { llm: { baseUrl: e.target.value.trim() } } })
                }
                placeholder="https://api.example.com/v1"
                className="font-mono text-[13px]"
                spellCheck={false}
              />
            </SettingRow>
            <SettingRow title="API key" vertical>
              <SecretInput slot="llm" />
            </SettingRow>
          </>
        )}
        <SettingRow title="Model" vertical>
          <div className="w-full">
            <ModelField
              value={f.llm.model}
              onChange={(m) => void patch({ formatting: { llm: { model: m } } })}
              known={LLM_PRESETS.find((p) => p.id === llmPreset)?.models ?? []}
              discovered={discovered}
              discovering={discovering}
              onDiscover={discover}
              discoverError={discoverError}
              placeholder="e.g. llama-3.1-8b-instant"
            />
          </div>
        </SettingRow>
        <SettingRow
          title="Minimum length"
          description="Skip the model for very short dictations; the rule-based pass is enough for "yes, sounds good"."
        >
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={1}
              max={50}
              className="w-20 text-right"
              value={f.llm.minWords}
              onChange={(e) =>
                void patch({
                  formatting: { llm: { minWords: Math.max(1, Number(e.target.value)) } }
                })
              }
            />
            <span className="text-sm text-muted-foreground">words</span>
          </div>
        </SettingRow>
        <SettingRow
          title="Timeout"
          description="If the model is slower than this, the light result is inserted instead."
        >
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={1}
              max={60}
              className="w-20 text-right"
              value={Math.round(f.llm.timeoutMs / 1000)}
              onChange={(e) =>
                void patch({
                  formatting: { llm: { timeoutMs: Math.max(1000, Number(e.target.value) * 1000) } }
                })
              }
            />
            <span className="text-sm text-muted-foreground">s</span>
          </div>
        </SettingRow>
        <SettingRow
          title="Test model"
          description="Sends a messy sentence and checks that it comes back clean."
          vertical
        >
          <div className="flex w-full items-center gap-3">
            <Button onClick={test} disabled={testing || !f.llm.model}>
              {testing ? <Loader2 className="animate-spin" /> : <Play />} Run test
            </Button>
          </div>
          {result && (
            <div className="w-full">
              <TestResult
                result={result}
                onPickModel={(m) => void patch({ formatting: { llm: { model: m } } })}
              />
            </div>
          )}
        </SettingRow>
      </Section>

      <Section
        title="Per-app rules"
        description="Match on the window title or process name. First matching rule wins."
        actions={
          <Button variant="outline" size="sm" onClick={addRule}>
            <Plus /> Add rule
          </Button>
        }
      >
        {f.appRules.length === 0 ? (
          <div className="py-2 text-[13px] text-muted-foreground">
            No rules. Example: match "slack" → casual, light formatting.
          </div>
        ) : (
          f.appRules.map((r) => (
            <div key={r.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
              <Input
                value={r.match}
                placeholder="slack, outlook, Code.exe…"
                onChange={(e) => updateRule(r.id, { match: e.target.value })}
                className="flex-1"
              />
              <Select value={r.tone} onValueChange={(v) => updateRule(r.id, { tone: v as Tone })}>
                <SelectTrigger className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TONES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label} tone
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={r.formatting ?? 'inherit'}
                onValueChange={(v) =>
                  updateRule(r.id, {
                    formatting: v === 'inherit' ? undefined : (v as FormattingMode)
                  })
                }
              >
                <SelectTrigger className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="inherit">Default mode</SelectItem>
                  <SelectItem value="off">Off</SelectItem>
                  <SelectItem value="light">Light</SelectItem>
                  <SelectItem value="smart">Smart</SelectItem>
                </SelectContent>
              </Select>
              <Button variant="ghost" size="icon-sm" onClick={() => removeRule(r.id)}>
                <Trash2 />
              </Button>
            </div>
          ))
        )}
      </Section>
    </div>
  )
}
