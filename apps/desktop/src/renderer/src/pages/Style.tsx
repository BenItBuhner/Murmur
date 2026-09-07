import React, { useEffect, useRef, useState } from 'react'
import { Loader2, Play, Plus, Sparkles, Trash2, WandSparkles } from 'lucide-react'
import type {
  AppRule,
  BulletMarker,
  FormattingMode,
  HesitationLevel,
  ListStyle,
  ListsMode,
  LlmFreedom,
  LlmStructure,
  NumbersMode,
  RepetitionScope,
  Tone
} from '@shared/settings'
import { LLM_INSTRUCTIONS_MAX } from '@shared/settings'
import { MURMUR_LLM_MODEL } from '@shared/inference'
import type { LlmStatus, PreviewResult, ProviderTestResult } from '@shared/types'
import { LLM_PRESETS } from '@core/stt/presets'
import { Button } from '@renderer/components/ui/button'
import { Input, Textarea } from '@renderer/components/ui/input'
import { Switch } from '@renderer/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { Badge, Segmented } from '@renderer/components/ui/misc'
import { PageHeader, Section, SettingRow } from '@renderer/components/SettingRow'
import { ModelField, SecretInput, TestResult } from '@renderer/components/ProviderForm'
import { planLabel, useInference } from '@renderer/hooks/useInference'
import { useSettings } from '@renderer/hooks/useSettings'
import { cn, uid } from '@renderer/lib/utils'

/** The Murmur entry of the formatting-model server picker; only offered by cloud builds. */
const MURMUR_LLM_PRESET = { id: 'murmur', name: 'Murmur (included with your account)' }

// ---- option catalogues -----------------------------------------------------------------------

interface Level<T extends string> {
  value: T
  label: string
  hint: string
}

const TONES: Level<Tone>[] = [
  {
    value: 'auto',
    label: 'Auto',
    hint: 'Casual in chat apps, professional in email and documents.'
  },
  { value: 'casual', label: 'Casual', hint: 'Relaxed, contractions, fragments are fine.' },
  { value: 'neutral', label: 'Neutral', hint: 'Clean sentences, faithful to how you talk.' },
  { value: 'professional', label: 'Professional', hint: 'Complete sentences, no slang.' }
]

const MODES: Level<FormattingMode>[] = [
  { value: 'off', label: 'Off', hint: 'Insert exactly what the speech model heard.' },
  {
    value: 'light',
    label: 'Light',
    hint: 'Rules only, instant: fillers, hesitation, repeats, self-corrections, lists, numbers, dictionary, punctuation.'
  },
  {
    value: 'smart',
    label: 'Smart',
    hint: 'Rules first, then a language model polishes the result. Every edit the model makes is checked against your words before anything is inserted; if it misbehaves or is slow, the rule-based text goes in.'
  }
]

const HESITATIONS: Level<HesitationLevel>[] = [
  { value: 'off', label: 'Off', hint: 'Phrases like “you know” stay exactly as spoken.' },
  {
    value: 'light',
    label: 'Light',
    hint: 'Pure hesitation goes wherever the transcript marks a pause: “you know”, “I mean”, a pause-“like”, “let me think”, “so yeah”, “okay so”, and a conjunction left hanging at the very end. “Do you know”, “I like” and “I mean it” are untouched.'
  },
  {
    value: 'thorough',
    label: 'Thorough',
    hint: 'Also hedges and openers when they are asides: “sort of”, “basically”, “actually”, “I guess”, “or whatever”, a leading “Okay, so, …”, and trailing “, yeah”. Tag questions like “, right?” stay.'
  }
]

const REPETITIONS: Level<RepetitionScope | 'off'>[] = [
  { value: 'off', label: 'Off', hint: 'Repeated words stay as spoken.' },
  {
    value: 'words',
    label: 'Words',
    hint: '“the the report”, “I, I think” and part-word stutters (“th- the”). Intentional repeats keep their commas: “no, no, no”.'
  },
  {
    value: 'phrases',
    label: 'Phrases',
    hint: 'Also repeated runs of up to five words: “I think, I think we should” and “we need to, we need to go”.'
  },
  {
    value: 'thorough',
    label: 'Thorough',
    hint: 'Also abandoned restarts, where you stop mid-phrase and start again: “I want to, I need to go” becomes “I need to go”.'
  }
]

const LISTS: Level<ListsMode>[] = [
  {
    value: 'off',
    label: 'Off',
    hint: 'Never turned into a list; the model is told to keep your layout too.'
  },
  {
    value: 'spoken',
    label: 'Spoken',
    hint: 'Only when you ask for one: “bullet point …”, “number one …”, “step one …”, or “make this a numbered list: …”. The instruction itself is removed.'
  },
  {
    value: 'auto',
    label: 'Auto',
    hint: 'Also when you enumerate: “first…, second…, third…”, “1. …, 2. …”, or “here are three things: a, b and c”. Never inside code editors or terminals.'
  }
]

const LIST_STYLES: Level<ListStyle>[] = [
  {
    value: 'auto',
    label: 'Auto',
    hint: 'Numbers when the order matters (“first, second”, “step one”), bullets otherwise.'
  },
  { value: 'bullets', label: 'Bullets', hint: 'Every list becomes bullets.' },
  { value: 'numbers', label: 'Numbers', hint: 'Every list becomes 1. 2. 3.' }
]

const MARKERS: Level<BulletMarker>[] = [
  {
    value: '-',
    label: '-',
    hint: '“- ” turns into a real bullet in Markdown-aware apps (Slack, Notion, GitHub).'
  },
  { value: '•', label: '•', hint: '“• ” looks right in plain text fields and email.' },
  { value: '*', label: '*', hint: '“* ” is the other Markdown bullet.' }
]

const NUMBERS: Level<NumbersMode>[] = [
  { value: 'off', label: 'Off', hint: 'Numbers stay as spoken.' },
  {
    value: 'smart',
    label: 'Smart',
    hint: 'Digits from ten up, and whenever a unit makes them natural: “five pm” → “5 pm”, “twenty three percent” → “23%”, “ten dollars” → “$10”, “version two point three” → “version 2.3”, “twenty twenty six” → “2026”. Sentences never start with a digit and “one of them” is left alone.'
  },
  {
    value: 'all',
    label: 'Always',
    hint: 'Every number becomes digits (“five apples” → “5 apples”). Code editors and terminals always use this.'
  }
]

const FREEDOMS: Level<LlmFreedom>[] = [
  {
    value: 'strict',
    label: 'Strict',
    hint: 'Punctuation, casing, spelling, mis-hearings, hesitation and self-corrections only. Any other change the model makes is reverted to your words.'
  },
  {
    value: 'balanced',
    label: 'Balanced',
    hint: 'Also grammar slips (“we was” → “we were”), missing articles and informal spellings. Rephrasing, synonyms and politeness changes (“can” → “could”) are reverted.'
  },
  {
    value: 'natural',
    label: 'Natural',
    hint: 'The model may smooth awkward phrasing so it reads the way you would write it. Names, numbers, negations and every point you made are still protected.'
  }
]

const STRUCTURES: Level<LlmStructure>[] = [
  {
    value: 'keep',
    label: 'Keep layout',
    hint: 'The model preserves your line breaks and paragraphs exactly.'
  },
  {
    value: 'assist',
    label: 'Assist',
    hint: 'The model may lay out an enumeration as a list and start a new paragraph at a clear topic change. Lists must be enabled above; code editors and terminals always keep the layout.'
  }
]

function LevelRow<T extends string>({
  title,
  levels,
  value,
  onChange,
  intro
}: {
  title: React.ReactNode
  levels: Level<T>[]
  value: T
  onChange: (v: T) => void
  intro?: string
}): React.JSX.Element {
  const current = levels.find((l) => l.value === value)
  return (
    <SettingRow
      title={title}
      description={
        <>
          {intro && <span className="block">{intro}</span>}
          <span className="block">{current?.hint}</span>
        </>
      }
    >
      <Segmented<T>
        value={value}
        onChange={onChange}
        options={levels.map(({ value: v, label }) => ({ value: v, label }))}
      />
    </SettingRow>
  )
}

/** Local text state that follows `source` whenever it changes (e.g. after a sync), without effects. */
function useSyncedText(source: string): [string, (v: string) => void] {
  const [text, setText] = useState(source)
  const [seen, setSeen] = useState(source)
  if (seen !== source) {
    setSeen(source)
    setText(source)
  }
  return [text, setText]
}

/** Comma-separated list editor that only writes back on blur/enter. */
function ListInput({
  value,
  onSave,
  placeholder
}: {
  value: string[]
  onSave: (list: string[]) => void
  placeholder?: string
}): React.JSX.Element {
  const joined = value.join(', ')
  const [text, setText] = useSyncedText(joined)
  const save = (): void => {
    const list = [
      ...new Set(
        text
          .split(/[,\n]/)
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean)
      )
    ]
    if (list.join(', ') !== joined) onSave(list)
  }
  return (
    <Input
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => e.key === 'Enter' && save()}
      placeholder={placeholder}
      className="font-mono text-[13px]"
    />
  )
}

// ---- page ------------------------------------------------------------------------------------

export function StylePage(): React.JSX.Element {
  const { settings, patch } = useSettings()
  const inference = useInference()
  const f = settings.formatting
  const murmurLlm = inference.routing.llm === 'murmur'
  const [discovered, setDiscovered] = useState<string[] | null>(null)
  const [discovering, setDiscovering] = useState(false)
  const [discoverError, setDiscoverError] = useState<string>()
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<ProviderTestResult | null>(null)
  const [llmPreset, setLlmPreset] = useState(() =>
    inference.offersMurmur && f.llm.source === 'murmur'
      ? MURMUR_LLM_PRESET.id
      : f.llm.sameAsStt
        ? 'same'
        : 'custom'
  )
  const [instructions, setInstructions] = useSyncedText(f.llm.instructions)
  const serverOptions = inference.offersMurmur ? [MURMUR_LLM_PRESET, ...LLM_PRESETS] : LLM_PRESETS

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
    if (id === MURMUR_LLM_PRESET.id) {
      void patch({ formatting: { llm: { source: 'murmur' } } })
      return
    }
    const p = LLM_PRESETS.find((x) => x.id === id)!
    if (id === 'same') void patch({ formatting: { llm: { source: 'custom', sameAsStt: true } } })
    else
      void patch({
        formatting: {
          llm: {
            source: 'custom',
            sameAsStt: false,
            baseUrl: p.baseUrl,
            model: p.defaultModel || f.llm.model
          }
        }
      })
  }
  const saveInstructions = (): void => {
    const next = instructions.slice(0, LLM_INSTRUCTIONS_MAX)
    if (next !== f.llm.instructions) void patch({ formatting: { llm: { instructions: next } } })
  }

  const addRule = (): void => {
    const rule: AppRule = { id: uid(), match: '', tone: 'auto' }
    void patch({ formatting: { appRules: [...f.appRules, rule] } })
  }
  const updateRule = (id: string, partial: Partial<AppRule>): void => {
    void patch({
      formatting: {
        appRules: f.appRules.map((r) => {
          if (r.id !== id) return r
          const next: AppRule = { ...r, ...partial }
          // Optional overrides are removed, not set to undefined, so sync sees a clean record.
          for (const key of Object.keys(partial) as Array<keyof AppRule>) {
            if (partial[key] === undefined) delete next[key]
          }
          return next
        })
      }
    })
  }
  const removeRule = (id: string): void =>
    void patch({ formatting: { appRules: f.appRules.filter((r) => r.id !== id) } })

  const modelReady = inference.llmReady

  return (
    <div className="space-y-8">
      <PageHeader
        title="Style"
        description="How raw speech becomes finished text. Rules run instantly on every dictation; smart formatting adds a language model on top and checks its work against your words before anything is inserted."
      />

      <Section title="Formatting">
        <LevelRow
          title="Mode"
          levels={MODES}
          value={f.mode}
          onChange={(v) => void patch({ formatting: { mode: v } })}
        />
        <LevelRow
          title="Tone"
          levels={TONES}
          value={f.tone}
          onChange={(v) => void patch({ formatting: { tone: v } })}
        />
      </Section>

      <Section
        title="Cleanup"
        description="What you did not mean to type. Every option here is rule-based, runs in microseconds, and still applies when the model is off or unavailable."
      >
        <SettingRow
          title="Filler sounds"
          description="um, uh, hmm and friends disappear; a sentence that opened with one is re-capitalized."
        >
          <Switch
            checked={f.removeFillers}
            onCheckedChange={(v) => void patch({ formatting: { removeFillers: v } })}
          />
        </SettingRow>
        {f.removeFillers && (
          <SettingRow
            title="Filler list"
            description="Comma separated. Whole words only, so “umbrella” is safe."
            vertical
          >
            <ListInput
              value={f.fillerWords}
              onSave={(list) => void patch({ formatting: { fillerWords: list } })}
            />
          </SettingRow>
        )}
        <LevelRow
          title="Hesitation phrases"
          levels={HESITATIONS}
          value={f.hesitations}
          onChange={(v) => void patch({ formatting: { hesitations: v } })}
        />
        {f.hesitations !== 'off' && (
          <SettingRow
            title="Your own hesitation phrases"
            description="Comma separated. Removed wherever a pause marks them, like the built-in list: at the start of a sentence, wrapped in commas, or before punctuation."
            vertical
          >
            <ListInput
              value={f.hesitationPhrases}
              onSave={(list) => void patch({ formatting: { hesitationPhrases: list } })}
              placeholder="at the end of the day, to be fair, what I'm trying to say is"
            />
          </SettingRow>
        )}
        <LevelRow
          title="Repetitions"
          levels={REPETITIONS}
          value={f.collapseRepeats ? f.repetitionScope : 'off'}
          onChange={(v) =>
            void patch({
              formatting:
                v === 'off'
                  ? { collapseRepeats: false }
                  : { collapseRepeats: true, repetitionScope: v }
            })
          }
        />
        <SettingRow
          title="Self-corrections"
          description="“Tuesday, no, Wednesday” keeps only Wednesday; “John, I mean, Jane” keeps Jane; “at 5, sorry, 6 pm” keeps 6 pm. Smart mode handles the trickier ones."
        >
          <Switch
            checked={f.selfCorrections}
            onCheckedChange={(v) => void patch({ formatting: { selfCorrections: v } })}
          />
        </SettingRow>
      </Section>

      <Section
        title="Structure"
        description="How the text is laid out. Lists and numbers are detected by rules from what you say; the destination app can override them (code and terminals never get lists and always get digits)."
      >
        <LevelRow
          title="Lists"
          levels={LISTS}
          value={f.lists}
          onChange={(v) => void patch({ formatting: { lists: v } })}
        />
        {f.lists !== 'off' && (
          <>
            <LevelRow
              title="List style"
              levels={LIST_STYLES}
              value={f.listStyle}
              onChange={(v) => void patch({ formatting: { listStyle: v } })}
            />
            {f.listStyle !== 'numbers' && (
              <LevelRow
                title="Bullet marker"
                levels={MARKERS}
                value={f.bulletMarker}
                onChange={(v) => void patch({ formatting: { bulletMarker: v } })}
              />
            )}
          </>
        )}
        <LevelRow
          title="Numbers as digits"
          levels={NUMBERS}
          value={f.numbers}
          onChange={(v) => void patch({ formatting: { numbers: v } })}
        />
        <SettingRow
          title="Spoken commands"
          description="“new line”, “new paragraph”, “scratch that”, “question mark”, “bullet point”, “number one”."
        >
          <Switch
            checked={f.spokenCommands}
            onCheckedChange={(v) => void patch({ formatting: { spokenCommands: v } })}
          />
        </SettingRow>
        <SettingRow
          title="“Press enter” command"
          description="End a dictation with “press enter” or “send it” to submit the message right away."
        >
          <Switch
            checked={f.pressEnterCommand}
            onCheckedChange={(v) => void patch({ formatting: { pressEnterCommand: v } })}
          />
        </SettingRow>
        <SettingRow
          title="Capitalize sentences"
          description="First letter of each sentence and list item, and the pronoun I."
        >
          <Switch
            checked={f.autoCapitalize}
            onCheckedChange={(v) => void patch({ formatting: { autoCapitalize: v } })}
          />
        </SettingRow>
        <SettingRow
          title="Trailing space"
          description="Add a space after each dictation so the next one flows on naturally. Lists end with a line break instead."
        >
          <Switch
            checked={f.trailingSpace}
            onCheckedChange={(v) => void patch({ formatting: { trailingSpace: v } })}
          />
        </SettingRow>
      </Section>

      <Section
        title="Smart formatting model"
        description={
          murmurLlm
            ? 'The formatting model that comes with your account. It receives the rule-based text, not the raw transcript, and its edits are reviewed word by word before anything is inserted.'
            : 'An OpenAI-compatible chat model. Fast small models (Groq Llama 8B, gpt-4o-mini, Cerebras) keep the round-trip under a second. The model receives the rule-based text, not the raw transcript, and its edits are reviewed word by word.'
        }
      >
        <SettingRow
          title="Server"
          description={
            llmPreset === 'same' && murmurLlm
              ? 'Follows your speech model, which is Murmur’s.'
              : undefined
          }
        >
          <Select value={llmPreset} onValueChange={choosePreset}>
            <SelectTrigger className="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {serverOptions.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        {murmurLlm ? (
          <SettingRow
            title="Model"
            description={
              inference.signedIn
                ? `Provided by this Murmur instance on the ${planLabel(inference.plan)} plan.`
                : 'Sign in to use Murmur models.'
            }
          >
            <Badge variant="outline" className="font-mono">
              {inference.status?.models.llm ?? MURMUR_LLM_MODEL}
            </Badge>
          </SettingRow>
        ) : (
          <>
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
          </>
        )}
        <LevelRow
          title="How much may it change"
          intro="Every level fixes punctuation, casing, spelling, mis-hearings, hesitation and self-corrections."
          levels={FREEDOMS}
          value={f.llm.freedom}
          onChange={(v) => void patch({ formatting: { llm: { freedom: v } } })}
        />
        <LevelRow
          title="Layout"
          levels={STRUCTURES}
          value={f.llm.structure}
          onChange={(v) => void patch({ formatting: { llm: { structure: v } } })}
        />
        <SettingRow
          title="Your instructions"
          description={`Added to the model's instructions on every dictation and applied before tone. Per-app rules below can add more. ${instructions.length}/${LLM_INSTRUCTIONS_MAX}`}
          vertical
        >
          <Textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value.slice(0, LLM_INSTRUCTIONS_MAX))}
            onBlur={saveInstructions}
            placeholder={
              'Use British spelling.\nWrite dates as 2026-09-06.\nNever use the Oxford comma.\nKeep my sign-off exactly as I say it.'
            }
            className="min-h-24 text-[13px]"
            spellCheck={false}
          />
        </SettingRow>
        <SettingRow
          title="Worked examples"
          description="Send three short before/after examples with every request. Small models follow them far better than rules; turn this off to save tokens on very slow connections."
        >
          <Switch
            checked={f.llm.examples}
            onCheckedChange={(v) => void patch({ formatting: { llm: { examples: v } } })}
          />
        </SettingRow>
        <SettingRow
          title="Minimum length"
          description="Skip the model for very short dictations; the rules are enough for “yes, sounds good”."
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
          description="If the model is slower than this, the rule-based result is inserted instead."
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
            <Button onClick={test} disabled={testing || !modelReady}>
              {testing ? <Loader2 className="animate-spin" /> : <Play />} Run test
            </Button>
            {!modelReady && (
              <span className="text-[13px] text-muted-foreground">
                {murmurLlm ? 'Sign in first.' : 'Choose a server and model first.'}
              </span>
            )}
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
        description="Match on the window title or process name; the first matching rule wins. Anything left on “Default” follows the settings above."
        actions={
          <Button variant="outline" size="sm" onClick={addRule}>
            <Plus /> Add rule
          </Button>
        }
      >
        {f.appRules.length === 0 ? (
          <div className="py-2 text-[13px] text-muted-foreground">
            No rules. Examples: “slack” → casual, no lists; “Code.exe” → strict model, digits
            always; “outlook” → professional with extra instructions.
          </div>
        ) : (
          f.appRules.map((r) => (
            <RuleEditor key={r.id} rule={r} onChange={updateRule} onRemove={removeRule} />
          ))
        )}
      </Section>

      <Playground modelReady={modelReady && f.mode === 'smart'} />
    </div>
  )
}

// ---- per-app rule ----------------------------------------------------------------------------

function RuleSelect<T extends string>({
  label,
  value,
  options,
  onChange,
  width = 'w-40'
}: {
  label: string
  value: T | undefined
  options: Array<{ value: T; label: string }>
  onChange: (v: T | undefined) => void
  width?: string
}): React.JSX.Element {
  return (
    <label className="flex flex-col gap-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
      {label}
      <Select
        value={value ?? 'inherit'}
        onValueChange={(v) => onChange(v === 'inherit' ? undefined : (v as T))}
      >
        <SelectTrigger className={cn(width, 'normal-case tracking-normal')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="inherit">Default</SelectItem>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  )
}

function RuleEditor({
  rule: r,
  onChange,
  onRemove
}: {
  rule: AppRule
  onChange: (id: string, partial: Partial<AppRule>) => void
  onRemove: (id: string) => void
}): React.JSX.Element {
  const [instructions, setInstructions] = useSyncedText(r.instructions ?? '')
  return (
    <div className="space-y-3 py-4 first:pt-0 last:pb-0">
      <div className="flex items-center gap-3">
        <Input
          value={r.match}
          placeholder="slack, outlook, Code.exe…"
          onChange={(e) => onChange(r.id, { match: e.target.value })}
          className="flex-1"
        />
        <Button variant="ghost" size="icon-sm" onClick={() => onRemove(r.id)} title="Remove rule">
          <Trash2 />
        </Button>
      </div>
      <div className="flex flex-wrap gap-3">
        <RuleSelect
          label="Tone"
          value={r.tone === 'auto' ? undefined : r.tone}
          options={TONES.filter((t) => t.value !== 'auto').map(({ value, label }) => ({
            value,
            label
          }))}
          onChange={(v) => onChange(r.id, { tone: v ?? 'auto' })}
          width="w-36"
        />
        <RuleSelect
          label="Mode"
          value={r.formatting}
          options={MODES.map(({ value, label }) => ({ value, label }))}
          onChange={(v) => onChange(r.id, { formatting: v })}
          width="w-32"
        />
        <RuleSelect
          label="Lists"
          value={r.lists}
          options={LISTS.map(({ value, label }) => ({ value, label }))}
          onChange={(v) => onChange(r.id, { lists: v })}
          width="w-32"
        />
        <RuleSelect
          label="Numbers"
          value={r.numbers}
          options={NUMBERS.map(({ value, label }) => ({ value, label }))}
          onChange={(v) => onChange(r.id, { numbers: v })}
          width="w-32"
        />
        <RuleSelect
          label="Model freedom"
          value={r.freedom}
          options={FREEDOMS.map(({ value, label }) => ({ value, label }))}
          onChange={(v) => onChange(r.id, { freedom: v })}
          width="w-36"
        />
        <label className="flex flex-col gap-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Trailing space
          <Select
            value={r.trailingSpace === undefined ? 'inherit' : r.trailingSpace ? 'on' : 'off'}
            onValueChange={(v) =>
              onChange(r.id, { trailingSpace: v === 'inherit' ? undefined : v === 'on' })
            }
          >
            <SelectTrigger className="w-32 normal-case tracking-normal">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="inherit">Default</SelectItem>
              <SelectItem value="on">On</SelectItem>
              <SelectItem value="off">Off</SelectItem>
            </SelectContent>
          </Select>
        </label>
      </div>
      <Input
        value={instructions}
        onChange={(e) => setInstructions(e.target.value.slice(0, LLM_INSTRUCTIONS_MAX))}
        onBlur={() => {
          const next = instructions.trim()
          if (next !== (r.instructions ?? '')) onChange(r.id, { instructions: next || undefined })
        }}
        placeholder="Extra model instructions for this app only, e.g. “Keep it to one short paragraph.”"
        className="text-[13px]"
      />
    </div>
  )
}

// ---- playground ------------------------------------------------------------------------------

const SAMPLE =
  'um so okay here are three things for today, first finish the the deck, second email the vendor about, you know, the pricing, and third book the flights for, I mean, twenty five people at five pm, no, six pm'

function outcomeBadge(status: LlmStatus): React.JSX.Element {
  switch (status.outcome) {
    case 'used':
      return <Badge variant="success">model used</Badge>
    case 'partial':
      return (
        <Badge variant="success">
          model used · {status.reverted} edit{status.reverted === 1 ? '' : 's'} reverted
        </Badge>
      )
    case 'rejected':
      return <Badge variant="destructive">model rejected: {status.detail}</Badge>
    case 'failed':
      return <Badge variant="destructive">model failed: {status.detail}</Badge>
    default:
      return <Badge variant="outline">model skipped: {status.detail}</Badge>
  }
}

function Playground({ modelReady }: { modelReady: boolean }): React.JSX.Element {
  const [raw, setRaw] = useState(SAMPLE)
  const [app, setApp] = useState('')
  const [out, setOut] = useState<PreviewResult | null>(null)
  const [running, setRunning] = useState(false)
  const requestId = useRef(0)

  useEffect(() => {
    if (!raw.trim()) {
      requestId.current++
      return
    }
    const id = ++requestId.current
    const t = setTimeout(() => {
      void window.murmur.pipeline.preview({ raw, app }).then((r) => {
        if (requestId.current === id)
          setOut((prev) => (prev?.smart ? { ...r, smart: undefined } : r))
      })
    }, 150)
    return () => clearTimeout(t)
  }, [raw, app])

  const runModel = async (): Promise<void> => {
    setRunning(true)
    const id = ++requestId.current
    try {
      const r = await window.murmur.pipeline.preview({ raw, app, smart: true })
      if (requestId.current === id) setOut(r)
    } finally {
      setRunning(false)
    }
  }

  const reverted = out?.smart?.review?.filter((d) => !d.accept) ?? []
  const accepted = out?.smart?.review?.filter((d) => d.accept) ?? []

  return (
    <Section
      title="Try it"
      description="Paste a messy transcript to see exactly what the rules do, which settings apply for a given app, and what the model would change."
    >
      <div className="space-y-4 py-1">
        <Textarea
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          className="min-h-24 text-[13px]"
          placeholder="Type or paste a raw transcript…"
          spellCheck={false}
        />
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-[13px] text-muted-foreground">
            As if dictating into
            <Input
              value={app}
              onChange={(e) => setApp(e.target.value)}
              placeholder="any text field"
              className="w-44"
            />
          </label>
          <Button
            variant="outline"
            size="sm"
            onClick={runModel}
            disabled={!modelReady || running || !raw.trim()}
            title={modelReady ? undefined : 'Choose Smart mode and configure a model first'}
          >
            {running ? <Loader2 className="animate-spin" /> : <Sparkles />} Run with model
          </Button>
        </div>

        {out && (
          <>
            <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
              <Badge variant="outline">
                {out.style.category === 'unknown' ? 'text field' : out.style.category}
              </Badge>
              {out.style.ruleMatch && (
                <Badge variant="secondary">rule “{out.style.ruleMatch}”</Badge>
              )}
              <Badge variant="secondary">tone {out.style.tone}</Badge>
              <Badge variant="secondary">mode {out.style.mode}</Badge>
              <Badge variant="secondary">lists {out.style.lists}</Badge>
              <Badge variant="secondary">numbers {out.style.numbers}</Badge>
              <Badge variant="secondary">model {out.style.freedom}</Badge>
              <Badge variant="secondary">layout {out.style.structure}</Badge>
            </div>

            <div>
              <div className="mb-1 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                <WandSparkles className="size-3.5" /> Rules
                <span className="normal-case tracking-normal font-normal">
                  · {out.light.wordCount} words
                  {out.light.pressEnter && ' · presses Enter'}
                  {out.light.isQuestion && ' · question'}
                  {out.light.listRequested &&
                    ` · ${out.light.listRequested === 'any' ? 'a' : out.light.listRequested} list requested`}
                </span>
              </div>
              <div className="whitespace-pre-wrap rounded-lg bg-muted/60 px-3 py-2 text-[13px]">
                {out.light.text || (
                  <span className="text-muted-foreground">(nothing to insert)</span>
                )}
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {out.light.stages.length === 0 ? (
                  <span className="text-[11px] text-muted-foreground">
                    No stage changed the text.
                  </span>
                ) : (
                  out.light.stages.map((s) => (
                    <Badge key={s} variant="outline">
                      {s}
                    </Badge>
                  ))
                )}
              </div>
            </div>

            {out.smart && (
              <div>
                <div className="mb-1 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  <Sparkles className="size-3.5" /> Model
                  <span className="normal-case tracking-normal font-normal">
                    · {out.smart.llmMs} ms
                  </span>
                  {outcomeBadge(out.smart.status)}
                </div>
                {(out.smart.text || out.smart.modelText) && (
                  <div className="whitespace-pre-wrap rounded-lg bg-muted/60 px-3 py-2 text-[13px]">
                    {out.smart.text ?? out.smart.modelText}
                  </div>
                )}
                {out.smart.status.outcome === 'rejected' &&
                  out.smart.modelText &&
                  out.smart.text === undefined && (
                    <p className="mt-1 text-[12px] text-muted-foreground">
                      This is what the model returned; the rule-based text above would have been
                      inserted.
                    </p>
                  )}
                {!!out.smart.review?.length && (
                  <div className="mt-2 space-y-1 text-[12px]">
                    {[...reverted, ...accepted].map((d, i) => (
                      <div key={i} className="flex flex-wrap items-baseline gap-2">
                        <Badge
                          variant={d.accept ? 'success' : 'destructive'}
                          className="w-16 justify-center"
                        >
                          {d.accept ? 'kept' : 'reverted'}
                        </Badge>
                        <span className="font-mono text-muted-foreground line-through">
                          {d.from || '∅'}
                        </span>
                        <span className="text-muted-foreground">→</span>
                        <span className="font-mono">{d.to || '∅'}</span>
                        <span className="text-muted-foreground">({d.why})</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </Section>
  )
}
