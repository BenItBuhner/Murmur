import React, { useEffect, useState } from 'react'
import { ArrowLeft, ArrowRight, BookA, Check, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@renderer/components/ui/button'
import { Input, Textarea } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Switch } from '@renderer/components/ui/switch'
import { Badge, Segmented } from '@renderer/components/ui/misc'
import { KeyCaps, platformFor } from '@renderer/components/KeyCaps'
import { HotkeyRecorder } from '@renderer/components/HotkeyRecorder'
import { Wordmark } from '@renderer/components/Shell'
import { useCloud } from '@renderer/hooks/useCloud'
import { useInference } from '@renderer/hooks/useInference'
import { useSettings } from '@renderer/hooks/useSettings'
import { cn, uid } from '@renderer/lib/utils'
import { ProvidersPage } from './Providers'
import { AudioPage } from './Audio'
import type { DictionaryEntry, HandsFreeTrigger, Tone } from '@shared/settings'

type StepId = 'welcome' | 'personalize' | 'model' | 'mic' | 'shortcut' | 'try'

const TITLES: Record<StepId, string> = {
  welcome: 'Welcome',
  personalize: 'Personalize',
  model: 'Speech model',
  mic: 'Microphone',
  shortcut: 'Shortcut',
  try: 'Try it'
}

const TONES: Array<{ value: Tone; label: string }> = [
  { value: 'auto', label: 'Auto' },
  { value: 'casual', label: 'Casual' },
  { value: 'neutral', label: 'Neutral' },
  { value: 'professional', label: 'Professional' }
]

/**
 * First-run flow. Account-level steps (Personalize) run once per account and are skipped on the
 * next device; device-level steps (model, microphone, shortcut) run on every install because API
 * keys and hardware are local.
 */
export function Onboarding(): React.JSX.Element {
  const { settings, patch, info } = useSettings()
  const cloud = useCloud()
  const inference = useInference()
  const [steps, setSteps] = useState<StepId[]>(['welcome'])
  const [index, setIndex] = useState(0)
  const [sttOk, setSttOk] = useState(false)
  const [dictated, setDictated] = useState(false)
  const platform = platformFor(info?.platform)

  useEffect(() => window.murmur.history.onAdded((e) => e.finalText && setDictated(true)), [])

  const signedIn = cloud.enabled && cloud.clerk.signedIn
  const accountOnboarded = !!cloud.status?.user?.onboardingCompletedAt
  const returning = signedIn && accountOnboarded
  const firstName = cloud.clerk.firstName ?? cloud.status?.user?.name?.split(' ')[0]
  const murmurModels = inference.routing.stt === 'murmur'

  const step = steps[index]
  const configured = inference.sttReady
  const canNext = step === 'model' ? configured : true
  const last = index === steps.length - 1

  const start = (): void => {
    const flow: StepId[] = ['welcome']
    if (signedIn && !accountOnboarded) flow.push('personalize')
    flow.push('model', 'mic', 'shortcut', 'try')
    setSteps(flow)
    setIndex(1)
  }

  return (
    <div className="flex h-full flex-col">
      <div
        className={cn(
          'flex items-center justify-between px-8',
          info?.platform === 'win32' ? 'h-10 drag-region' : 'h-14'
        )}
      >
        <Wordmark />
        <ol className="no-drag flex items-center gap-1.5">
          {steps.map((s, i) => (
            <li
              key={s}
              className={cn(
                'h-0.5 w-8 rounded-full transition-colors duration-300',
                i <= index ? 'bg-primary' : 'bg-border'
              )}
              title={TITLES[s]}
            />
          ))}
        </ol>
      </div>

      <div className="flex-1 overflow-y-auto px-8 pb-8">
        <div className="mx-auto max-w-2xl pt-6 animate-fade-in" key={step}>
          {step === 'welcome' && (
            <div className="mx-auto max-w-xl space-y-7 pt-12">
              {returning ? (
                <>
                  <h1 className="serif-display text-[56px]">
                    Welcome back{firstName ? `, ${firstName}` : ''}.
                  </h1>
                  <p className="max-w-md text-[16px] leading-relaxed text-muted-foreground">
                    Your account is already set up, so your dictionary, snippets and style are on
                    this computer now. Three quick device steps and you are dictating:{' '}
                    {inference.offersMurmur
                      ? 'confirm your speech model'
                      : 'connect a speech model'}
                    , check the microphone, pick a shortcut.
                  </p>
                  <FeatureList
                    items={[
                      `${settings.dictionary.length} dictionary ${settings.dictionary.length === 1 ? 'word' : 'words'}`,
                      `${settings.snippets.length} ${settings.snippets.length === 1 ? 'snippet' : 'snippets'}`,
                      `Tone: ${TONES.find((t) => t.value === settings.formatting.tone)?.label ?? 'Auto'}`
                    ]}
                  />
                </>
              ) : (
                <>
                  <h1 className="serif-display text-[64px]">
                    Speak.
                    <br />
                    <span className="italic text-muted-foreground">It types.</span>
                  </h1>
                  <p className="max-w-md text-[16px] leading-relaxed text-muted-foreground">
                    Hold one key anywhere on your computer, say what you mean, let go. Murmur
                    transcribes it, cleans up the ums and self-corrections, and drops finished text
                    right where your cursor is.
                  </p>
                  <FeatureList
                    items={[
                      'Hold to talk, tap for hands-free',
                      inference.offersMurmur
                        ? 'Speech and formatting models included with your account, or bring your own'
                        : 'Your own speech model: OpenAI, Groq, Deepgram, or a local whisper server',
                      signedIn
                        ? 'Your dictionary and snippets sync to every device you sign in on'
                        : 'Personal dictionary and snippets',
                      signedIn
                        ? 'Your own API keys, if you use any, stay on this device'
                        : 'Nothing stored anywhere but this device'
                    ]}
                  />
                </>
              )}
            </div>
          )}

          {step === 'personalize' && <PersonalizeStep />}

          {step === 'model' && (
            <div className="space-y-6">
              <Header
                title={inference.offersMurmur ? 'Your speech model' : 'Connect a speech model'}
                description={
                  inference.offersMurmur
                    ? 'Your account comes with speech and formatting models, so there is nothing to configure. Prefer your own provider or a local whisper server? Switch below; keys stay on this computer.'
                    : 'Murmur sends your recording to a transcription API you control. Pick a provider, paste a key, choose a model, and run the test. Keys stay on this computer.'
                }
              />
              <ProvidersPage embedded onReady={setSttOk} />
              {sttOk && (
                <p className="text-[13px] text-success">
                  {murmurModels
                    ? 'Working. You can switch to your own provider any time under Models.'
                    : 'Working. You can tweak fallback models later under Models.'}
                </p>
              )}
            </div>
          )}

          {step === 'mic' && (
            <div className="space-y-6">
              <Header
                title="Check your microphone"
                description="Say a few words and watch the level. If nothing moves, pick another device."
              />
              <AudioPage embedded />
            </div>
          )}

          {step === 'shortcut' && (
            <div className="space-y-6">
              <Header
                title="Your shortcut"
                description="This one key does both jobs. Keep the default or record your own."
              />
              <div className="rounded-2xl border bg-card p-5 space-y-5">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium">Push to talk</div>
                    <div className="text-[13px] text-muted-foreground">
                      Hold to record, release to insert
                    </div>
                  </div>
                  <HotkeyRecorder
                    value={settings.hotkeys.pushToTalk}
                    onChange={(keys) => void patch({ hotkeys: { pushToTalk: keys } })}
                    platform={platform}
                    sideSensitive={settings.hotkeys.sideSensitive}
                  />
                </div>
                <div className="flex items-center justify-between border-t pt-5">
                  <div>
                    <div className="text-sm font-medium">Hands-free</div>
                    <div className="text-[13px] text-muted-foreground">
                      How to lock a session without holding the key
                    </div>
                  </div>
                  <Segmented<HandsFreeTrigger>
                    value={settings.hotkeys.handsFreeTrigger}
                    onChange={(v) => void patch({ hotkeys: { handsFreeTrigger: v } })}
                    options={[
                      { value: 'tap', label: 'Tap' },
                      { value: 'double-tap', label: 'Double-tap' },
                      { value: 'off', label: 'Off' }
                    ]}
                  />
                </div>
              </div>
            </div>
          )}

          {step === 'try' && (
            <div className="space-y-6">
              <Header
                title="Try it"
                description="Click into the box, then hold your shortcut and say something like “Hey, this is my first dictation, new line, pretty neat.”"
              />
              <div className="flex items-center justify-center gap-3 rounded-2xl border bg-card px-5 py-4">
                <span className="text-sm text-muted-foreground">Hold</span>
                <KeyCaps
                  keys={settings.hotkeys.pushToTalk}
                  platform={platform}
                  sideSensitive={settings.hotkeys.sideSensitive}
                  size="lg"
                />
                <span className="text-sm text-muted-foreground">and speak</span>
              </div>
              <Textarea
                autoFocus
                placeholder="Your words will appear here…"
                className="min-h-36 text-[15px]"
              />
              {dictated && (
                <div className="flex items-center gap-2 rounded-lg border border-success/40 bg-success/5 px-4 py-3 text-sm animate-fade-in">
                  <Check className="size-4 text-success" /> That is it. Murmur now lives in your
                  tray; this window can be closed.
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between border-t px-8 py-4">
        <Button
          variant="ghost"
          onClick={() => setIndex((i) => Math.max(0, i - 1))}
          disabled={index === 0}
        >
          <ArrowLeft /> Back
        </Button>
        <div className="flex items-center gap-2">
          {step === 'model' && !configured && (
            <Button variant="ghost" onClick={() => setIndex((i) => i + 1)}>
              Skip for now
            </Button>
          )}
          {step === 'welcome' ? (
            <Button onClick={start}>
              Get started <ArrowRight />
            </Button>
          ) : last ? (
            <Button onClick={() => void window.murmur.app.completeOnboarding()}>
              Finish <Check />
            </Button>
          ) : (
            <Button onClick={() => setIndex((i) => i + 1)} disabled={!canNext}>
              Continue <ArrowRight />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

/** Account-level step: seed the dictionary and pick defaults that sync to every device. */
function PersonalizeStep(): React.JSX.Element {
  const { settings, patch } = useSettings()
  const cloud = useCloud()
  const [names, setNames] = useState(() => cloud.clerk.name ?? cloud.status?.user?.name ?? '')
  const [terms, setTerms] = useState('')

  const addWords = async (raw: string): Promise<void> => {
    const words = raw
      .split(/[,;\n]/)
      .map((w) => w.trim())
      .filter(Boolean)
    const existing = new Set(settings.dictionary.map((d) => d.word.toLowerCase()))
    const fresh: DictionaryEntry[] = words
      .filter((w) => !existing.has(w.toLowerCase()))
      .map((word) => ({ id: uid(), word, aliases: [], fuzzy: true, createdAt: Date.now() }))
    if (!fresh.length) {
      toast.message('Already in your dictionary')
      return
    }
    await patch({ dictionary: [...fresh, ...settings.dictionary] })
    toast.success(`Added ${fresh.length} ${fresh.length === 1 ? 'word' : 'words'}`)
  }

  return (
    <div className="space-y-6">
      <Header
        title={`Make it yours${cloud.clerk.firstName ? `, ${cloud.clerk.firstName}` : ''}`}
        description="These choices live in your account, so every device you sign in on picks them up. You only do this once."
      />

      <div className="rounded-2xl border bg-card p-5 space-y-5">
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium">
            <BookA className="size-4" /> Teach Murmur your name
          </div>
          <p className="text-[13px] text-muted-foreground">
            Speech models often misspell names. Anything in your dictionary is spelled the way you
            wrote it, every time.
          </p>
          <div className="flex gap-2">
            <Input
              value={names}
              onChange={(e) => setNames(e.target.value)}
              placeholder="Your name"
              onKeyDown={(e) => e.key === 'Enter' && names.trim() && void addWords(names)}
            />
            <Button variant="outline" onClick={() => void addWords(names)} disabled={!names.trim()}>
              <Plus /> Add
            </Button>
          </div>
        </div>
        <div className="space-y-2 border-t pt-5">
          <Label htmlFor="onb-terms">People, products and tools you say often</Label>
          <div className="flex gap-2">
            <Input
              id="onb-terms"
              value={terms}
              onChange={(e) => setTerms(e.target.value)}
              placeholder="Wispr Flow, Kubernetes, Priya"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && terms.trim()) {
                  void addWords(terms)
                  setTerms('')
                }
              }}
            />
            <Button
              variant="outline"
              onClick={() => {
                void addWords(terms)
                setTerms('')
              }}
              disabled={!terms.trim()}
            >
              <Plus /> Add
            </Button>
          </div>
          {settings.dictionary.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-1">
              {settings.dictionary.slice(0, 12).map((d) => (
                <Badge key={d.id} variant="secondary">
                  {d.word}
                </Badge>
              ))}
              {settings.dictionary.length > 12 && (
                <Badge variant="outline">+{settings.dictionary.length - 12} more</Badge>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="rounded-2xl border bg-card p-5 space-y-5">
        <div className="flex items-center justify-between gap-6">
          <div>
            <div className="text-sm font-medium">Default tone</div>
            <div className="text-[13px] text-muted-foreground">
              Auto reads the app you are typing in: casual in chat, professional in email.
            </div>
          </div>
          <Segmented<Tone>
            value={settings.formatting.tone}
            onChange={(v) => void patch({ formatting: { tone: v } })}
            options={TONES}
          />
        </div>
        <div className="flex items-center justify-between gap-6 border-t pt-5">
          <div>
            <div className="text-sm font-medium">Sync dictation history</div>
            <div className="text-[13px] text-muted-foreground">
              Keep the text of your dictations in your account so History shows every device. Off by
              default; your dictionary and snippets sync either way.
            </div>
          </div>
          <Switch
            checked={settings.cloud.historySync}
            onCheckedChange={(v) => void window.murmur.cloud.setHistorySync(v)}
          />
        </div>
      </div>
    </div>
  )
}

function Header({ title, description }: { title: string; description: string }): React.JSX.Element {
  return (
    <div>
      <h1 className="serif-display text-[36px]">{title}</h1>
      <p className="mt-2.5 max-w-xl text-[15px] leading-relaxed text-muted-foreground">
        {description}
      </p>
    </div>
  )
}

/** Facts set as hairline rows rather than boxed bullets. */
export function FeatureList({ items }: { items: string[] }): React.JSX.Element {
  return (
    <ul className="divide-y border-y text-[14px]">
      {items.map((t) => (
        <li key={t} className="flex items-start gap-3.5 py-3.5">
          <Check className="mt-0.5 size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
          <span>{t}</span>
        </li>
      ))}
    </ul>
  )
}
