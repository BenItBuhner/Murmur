'use client'

import { SignIn, useClerk } from '@clerk/nextjs'
import { Authenticated, AuthLoading, Unauthenticated, useMutation, useQuery } from 'convex/react'
import Link from 'next/link'
import { useEffect, useSyncExternalStore } from 'react'
import { Button, ButtonLink } from '@/components/ui/button'
import { inner, Surface } from '@/components/ui/surface'
import {
  api,
  type DeviceDto,
  type InferenceStatus,
  type StatsDto,
  type UserDto
} from '@/lib/backend-api'
import { cn } from '@/lib/cn'
import {
  formatAudioSeconds,
  formatNumber,
  formatPeriod,
  formatRelative,
  usagePeriod
} from '@/lib/format'
import { formatPrice, PRICING, proPerMonth } from '@/lib/pricing'

const MINUTE = 60_000
const subscribeNever = (): (() => void) => () => {}
const readMinute = (): number => Math.floor(Date.now() / MINUTE) * MINUTE

/** The clock at minute resolution: stable within a render, so usage periods and "last seen" agree. */
function useNow(): number {
  return useSyncExternalStore(subscribeNever, readMinute, readMinute)
}

export function AccountView() {
  return (
    <>
      <AuthLoading>
        <Placeholder />
      </AuthLoading>
      <Unauthenticated>
        <SignedOut />
      </Unauthenticated>
      <Authenticated>
        <SignedInAccount />
      </Authenticated>
    </>
  )
}

function Placeholder() {
  return (
    <Surface radius={32} padding={24} className="min-h-64 animate-pulse-soft">
      <div className="h-4 w-40 rounded-(--ri) bg-secondary" />
      <div className="mt-4 h-4 w-72 rounded-(--ri) bg-secondary" />
    </Surface>
  )
}

function SignedOut() {
  return (
    <div className="grid items-start gap-8 lg:grid-cols-[1fr_auto]">
      <div className="max-w-lg">
        <h2 className="serif-display text-[2rem]">Sign in to Murmur</h2>
        <p className="mt-3 text-[15px] leading-relaxed text-muted-foreground">
          The same account the desktop and Android apps use. Your dictionary, snippets, style and
          stats follow it to every device; the model you dictate with and any keys of your own stay
          on the device.
        </p>
        <ul className="mt-6 space-y-2.5 text-[14.5px] text-foreground/85">
          <li>See your plan and how much of this month’s allowance is used.</li>
          <li>Every device that has connected to the account.</li>
          <li>{PRICING.trialDays} days of Pro to start, no card; a free tier after that.</li>
        </ul>
      </div>
      <div className="flex justify-center lg:justify-end">
        <SignIn routing="hash" withSignUp fallback={<Placeholder />} />
      </div>
    </div>
  )
}

function SignedInAccount() {
  const ensure = useMutation(api.users.ensure)
  useEffect(() => {
    // Provisions the account row on first contact, exactly as the apps do after connecting.
    void ensure({})
  }, [ensure])

  const me = useQuery(api.users.me)
  const status = useQuery(api.inference.status)
  const stats = useQuery(api.stats.get)
  const devices = useQuery(api.devices.list)

  return (
    <div className="grid gap-5">
      <ProfileCard user={me ?? null} />
      <div className="grid gap-5 lg:grid-cols-[1.15fr_0.85fr]">
        <PlanCard status={status ?? null} />
        <StatsCard stats={stats ?? null} />
      </div>
      <DevicesCard devices={devices ?? null} />
    </div>
  )
}

function ProfileCard({ user }: { user: UserDto | null }) {
  const clerk = useClerk()
  const name = user?.name || 'Your account'
  return (
    <Surface radius={32} padding={20} className="flex flex-wrap items-center gap-4">
      {user?.imageUrl ? (
        // Clerk profile images come from a third-party host that changes per instance.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={user.imageUrl} alt="" className="size-12 rounded-full object-cover" />
      ) : (
        <span className="inline-flex size-12 items-center justify-center rounded-full bg-secondary text-muted-foreground">
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
          >
            <circle cx="12" cy="8" r="4" />
            <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
          </svg>
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[17px] font-semibold tracking-tight">{name}</div>
        {user?.email && (
          <div className="truncate text-[13.5px] text-muted-foreground">{user.email}</div>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" onClick={() => void clerk.openUserProfile()}>
          Manage account
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void clerk.signOut({ redirectUrl: '/account' })}
        >
          Sign out
        </Button>
      </div>
    </Surface>
  )
}

function PlanCard({ status }: { status: InferenceStatus | null }) {
  const period = usagePeriod(useNow())
  const plan = status?.plan ?? 'free'
  const thisMonth = status && status.usage.period === period ? status.usage : null
  const sttUsed = thisMonth?.sttSeconds ?? 0
  const tokensUsed = thisMonth?.llmTokens ?? 0
  const requests = (thisMonth?.sttRequests ?? 0) + (thisMonth?.llmRequests ?? 0)
  const radius = 32
  const padding = 20

  return (
    <Surface radius={radius} padding={padding} className="flex flex-col">
      <div className="flex items-start justify-between gap-4 px-1">
        <div>
          <div className="eyebrow">Plan</div>
          <h2 className="serif-display mt-2 text-[2rem]">{plan === 'pro' ? 'Pro' : 'Free'}</h2>
        </div>
        <span
          className={cn(
            'rounded-full px-2.5 py-1 text-[11px] font-medium tracking-[0.06em] uppercase',
            plan === 'pro' ? 'bg-success/12 text-success' : 'bg-secondary text-secondary-foreground'
          )}
        >
          {plan}
        </span>
      </div>
      <p className="mt-2 px-1 text-[14px] leading-relaxed text-muted-foreground">
        {status
          ? status.available
            ? `Murmur’s speech and formatting models come with the account. ${Math.round(status.limits.sttSecondsPerMonth / 60)} minutes of transcription and ${formatNumber(status.limits.llmTokensPerMonth)} formatting tokens a month, up to ${status.limits.requestsPerMinute} requests a minute, clips up to ${Math.round(status.limits.maxClipSeconds / 60)} minutes.`
            : 'This Murmur instance does not provide models of its own; the apps use the provider you connect under Models.'
          : 'Waiting for your account status…'}
      </p>

      <div className="mt-5 grid gap-2">
        <Meter
          label={`Transcription in ${formatPeriod(period)}`}
          value={sttUsed}
          max={status?.limits.sttSecondsPerMonth ?? 0}
          display={`${formatAudioSeconds(sttUsed)} of ${status ? formatAudioSeconds(status.limits.sttSecondsPerMonth) : '—'}`}
          radius={inner(radius, padding)}
        />
        <Meter
          label="Formatting tokens"
          value={tokensUsed}
          max={status?.limits.llmTokensPerMonth ?? 0}
          display={`${formatNumber(tokensUsed)} of ${status ? formatNumber(status.limits.llmTokensPerMonth) : '—'}`}
          radius={inner(radius, padding)}
        />
        <div className="flex items-baseline justify-between rounded-(--ri) bg-secondary px-4 py-3 text-[13.5px]">
          <span className="text-muted-foreground">Requests this month</span>
          <span className="font-medium tabular-nums">{formatNumber(requests)}</span>
        </div>
      </div>

      {plan !== 'pro' && (
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-(--ri) bg-primary px-4 py-3.5 text-primary-foreground">
          <div>
            <div className="text-[14.5px] font-medium">
              Pro is {formatPrice(proPerMonth('yearly'))} a month, billed yearly
            </div>
            <div className="text-[12.5px] text-primary-foreground/65">
              Or {formatPrice(PRICING.proMonthly)} monthly. Checkout opens here when billing goes
              live.
            </div>
          </div>
          <ButtonLink href="/pricing" variant="inverse" size="sm">
            What Pro includes
          </ButtonLink>
        </div>
      )}
    </Surface>
  )
}

function Meter({
  label,
  value,
  max,
  display,
  radius
}: {
  label: string
  value: number
  max: number
  display: string
  radius: number
}) {
  const ratio = max > 0 ? Math.min(1, value / max) : 0
  return (
    <div className="rounded-(--ri) bg-secondary px-4 py-3">
      <div className="flex items-baseline justify-between gap-4 text-[13.5px]">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium tabular-nums">{display}</span>
      </div>
      <div
        className="mt-2.5 h-1.5 overflow-hidden bg-card"
        style={{ borderRadius: Math.max(2, radius - 16) }}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={Math.min(value, max)}
        aria-label={label}
      >
        <div
          className={cn(
            'h-full rounded-[inherit] transition-[width] duration-500',
            ratio >= 0.9 ? 'bg-record' : 'bg-foreground/70'
          )}
          style={{ width: `${Math.round(ratio * 100)}%` }}
        />
      </div>
    </div>
  )
}

function StatsCard({ stats }: { stats: StatsDto | null }) {
  const minutes = stats ? Math.round(stats.totalSpeechMs / 60_000) : 0
  const items = [
    { label: 'Words dictated', value: stats ? formatNumber(stats.totalWords) : '—' },
    { label: 'Dictations', value: stats ? formatNumber(stats.totalSessions) : '—' },
    { label: 'Minutes spoken', value: stats ? formatNumber(minutes) : '—' },
    { label: 'Day streak', value: stats ? formatNumber(stats.streakDays) : '—' }
  ]
  return (
    <Surface radius={32} padding={20}>
      <div className="px-1">
        <div className="eyebrow">Across your devices</div>
        <h2 className="serif-display mt-2 text-[2rem]">Stats</h2>
      </div>
      <dl className="mt-5 grid grid-cols-2 gap-2">
        {items.map((item) => (
          <div key={item.label} className="rounded-(--ri) bg-secondary px-4 py-3.5">
            <dt className="text-[12.5px] text-muted-foreground">{item.label}</dt>
            <dd className="serif-display mt-1 text-[1.75rem] tabular-nums">{item.value}</dd>
          </div>
        ))}
      </dl>
      {stats?.lastSessionDay && (
        <p className="mt-3 px-1 text-[12.5px] text-muted-foreground">
          Last dictation on {stats.lastSessionDay}.
        </p>
      )}
    </Surface>
  )
}

const PLATFORM_NAMES: Record<DeviceDto['platform'], string> = {
  win32: 'Windows',
  darwin: 'macOS',
  linux: 'Linux',
  android: 'Android',
  ios: 'iOS',
  web: 'Web'
}

function DevicesCard({ devices }: { devices: DeviceDto[] | null }) {
  const now = useNow()
  return (
    <Surface radius={32} padding={20}>
      <div className="px-1">
        <div className="eyebrow">Devices</div>
        <h2 className="serif-display mt-2 text-[2rem]">Every install on this account</h2>
        <p className="mt-2 text-[14px] leading-relaxed text-muted-foreground">
          Removing a device is done from the app’s Account page; sign out on the device itself to
          end its session.
        </p>
      </div>
      {devices === null ? (
        <div className="mt-5 h-14 rounded-(--ri) bg-secondary animate-pulse-soft" />
      ) : devices.length === 0 ? (
        <div className="mt-5 rounded-(--ri) bg-secondary px-4 py-6 text-center text-[14px] text-muted-foreground">
          No device has signed in yet.{' '}
          <Link
            href="/download"
            className="text-foreground/80 underline decoration-border underline-offset-4 hover:text-foreground"
          >
            Download Murmur
          </Link>{' '}
          and sign in there.
        </div>
      ) : (
        <ul className="mt-5 grid gap-2">
          {devices.map((device) => (
            <li
              key={device.deviceId}
              className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 rounded-(--ri) bg-secondary px-4 py-3"
            >
              <span className="text-[14.5px] font-medium">{device.name}</span>
              <span className="text-[13px] text-muted-foreground tabular-nums">
                {PLATFORM_NAMES[device.platform]} · Murmur {device.appVersion} · last seen{' '}
                {formatRelative(device.lastSeenAt, now)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Surface>
  )
}
