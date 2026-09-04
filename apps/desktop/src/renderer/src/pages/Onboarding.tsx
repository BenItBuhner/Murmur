import React, { useEffect, useState } from 'react'
import { ArrowLeft, ArrowRight, Check } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Textarea } from '@renderer/components/ui/input'
import { Segmented } from '@renderer/components/ui/misc'
import { KeyCaps, platformFor } from '@renderer/components/KeyCaps'
import { HotkeyRecorder } from '@renderer/components/HotkeyRecorder'
import { Logo } from '@renderer/components/Shell'
import { useSettings } from '@renderer/hooks/useSettings'
import { cn } from '@renderer/lib/utils'
import { ProvidersPage } from './Providers'
import { AudioPage } from './Audio'
import type { HandsFreeTrigger } from '@shared/settings'

const STEPS = ['Welcome', 'Speech model', 'Microphone', 'Shortcut', 'Try it'] as const

export function Onboarding(): React.JSX.Element {
  const { settings, patch, info } = useSettings()
  const [step, setStep] = useState(0)
  const [sttOk, setSttOk] = useState(false)
  const [dictated, setDictated] = useState(false)
  const platform = platformFor(info?.platform)

  useEffect(() => window.murmur.history.onAdded((e) => e.finalText && setDictated(true)), [])

  const configured = !!settings.stt.baseUrl && !!settings.stt.model
  const canNext = step === 1 ? configured : true
  const last = step === STEPS.length - 1

  return (
    <div className="flex h-full flex-col">
      <div
        className={cn(
          'flex items-center justify-between px-8',
          info?.platform === 'win32' ? 'h-10 drag-region' : 'h-14'
        )}
      >
        <div className="flex items-center gap-2.5">
          <Logo />
          <span className="text-[15px] font-semibold tracking-tight">Murmur</span>
        </div>
        <ol className="no-drag flex items-center gap-1.5">
          {STEPS.map((s, i) => (
            <li
              key={s}
              className={cn(
                'h-1.5 w-8 rounded-full transition-colors',
                i <= step ? 'bg-primary' : 'bg-muted'
              )}
              title={s}
            />
          ))}
        </ol>
      </div>

      <div className="flex-1 overflow-y-auto px-8 pb-8">
        <div className="mx-auto max-w-2xl pt-6 animate-fade-in" key={step}>
          {step === 0 && (
            <div className="space-y-6 pt-10 text-center">
              <div className="mx-auto flex size-16 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-lg">
                <Logo className="size-10 rounded-xl [&>svg]:size-6" />
              </div>
              <h1 className="text-3xl font-semibold tracking-tight">Speak. It types.</h1>
              <p className="mx-auto max-w-md text-[15px] text-muted-foreground">
                Hold one key anywhere on your computer, say what you mean, let go. Murmur
                transcribes it, cleans up the ums and self-corrections, and drops finished text
                right where your cursor is.
              </p>
              <div className="mx-auto grid max-w-md gap-2 pt-2 text-left text-[13px]">
                {[
                  'Hold to talk, tap for hands-free',
                  'Your own speech model: OpenAI, Groq, Deepgram, or a local whisper server',
                  'Personal dictionary and snippets',
                  'Nothing stored anywhere but this device'
                ].map((t) => (
                  <div
                    key={t}
                    className="flex items-center gap-2.5 rounded-lg border bg-card px-3 py-2"
                  >
                    <Check className="size-4 text-success" /> {t}
                  </div>
                ))}
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="space-y-6">
              <Header
                title="Connect a speech model"
                description="Murmur sends your recording to a transcription API you control. Pick a provider, paste a key, choose a model, and run the test."
              />
              <ProvidersPage embedded onReady={setSttOk} />
              {sttOk && (
                <p className="text-[13px] text-success">
                  Working. You can tweak fallback models later under Models.
                </p>
              )}
            </div>
          )}

          {step === 2 && (
            <div className="space-y-6">
              <Header
                title="Check your microphone"
                description="Say a few words and watch the level. If nothing moves, pick another device."
              />
              <AudioPage embedded />
            </div>
          )}

          {step === 3 && (
            <div className="space-y-6">
              <Header
                title="Your shortcut"
                description="This one key does both jobs. Keep the default or record your own."
              />
              <div className="rounded-xl border bg-card p-5 shadow-xs space-y-5">
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

          {step === 4 && (
            <div className="space-y-6">
              <Header
                title="Try it"
                description="Click into the box, then hold your shortcut and say something like “Hey, this is my first dictation, new line, pretty neat.”"
              />
              <div className="flex items-center justify-center gap-3 rounded-xl border bg-card px-5 py-4 shadow-xs">
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
          onClick={() => setStep((s) => Math.max(0, s - 1))}
          disabled={step === 0}
        >
          <ArrowLeft /> Back
        </Button>
        <div className="flex items-center gap-2">
          {step === 1 && !configured && (
            <Button variant="ghost" onClick={() => setStep(2)}>
              Skip for now
            </Button>
          )}
          {last ? (
            <Button onClick={() => void window.murmur.app.completeOnboarding()}>
              Finish <Check />
            </Button>
          ) : (
            <Button onClick={() => setStep((s) => s + 1)} disabled={!canNext}>
              {step === 0 ? 'Get started' : 'Continue'} <ArrowRight />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

function Header({ title, description }: { title: string; description: string }): React.JSX.Element {
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
    </div>
  )
}
