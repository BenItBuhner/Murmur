'use client'

import { useState } from 'react'
import { ButtonLink } from '@/components/ui/button'
import { Surface } from '@/components/ui/surface'
import { cn } from '@/lib/cn'
import { formatPrice, PRICING, proPerMonth, TIERS, type Billing, type Tier } from '@/lib/pricing'

export function Plans() {
  const [billing, setBilling] = useState<Billing>('yearly')
  return (
    <div>
      <div className="flex justify-center">
        <BillingToggle value={billing} onChange={setBilling} />
      </div>
      <div className="mt-10 grid gap-5 lg:grid-cols-3">
        {TIERS.map((tier) => (
          <PlanCard key={tier.id} tier={tier} billing={billing} />
        ))}
      </div>
    </div>
  )
}

function BillingToggle({ value, onChange }: { value: Billing; onChange: (b: Billing) => void }) {
  const options: Array<{ value: Billing; label: string; hint?: string }> = [
    { value: 'monthly', label: 'Monthly' },
    { value: 'yearly', label: 'Yearly', hint: 'save 20%' }
  ]
  return (
    <div
      role="radiogroup"
      aria-label="Billing period"
      className="surface-inset inline-flex h-11 items-center rounded-full p-1"
    >
      {options.map((option) => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.value)}
            className={cn(
              'inline-flex h-9 items-center gap-2 rounded-full px-4 text-[14px] font-medium transition-colors duration-200',
              active
                ? 'bg-card text-foreground shadow-raised'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {option.label}
            {option.hint && (
              <span
                className={cn('text-[11px]', active ? 'text-success' : 'text-muted-foreground/80')}
              >
                {option.hint}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

function PlanCard({ tier, billing }: { tier: Tier; billing: Billing }) {
  const ink = tier.id === 'pro'
  const muted = ink ? 'text-primary-foreground/70' : 'text-muted-foreground'
  return (
    <Surface radius={32} padding={24} level={ink ? 'ink' : 'raised'} className="flex flex-col">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="serif-display text-[2rem]">{tier.name}</h2>
        {tier.id === 'free' && (
          <span className="rounded-full bg-secondary px-2.5 py-1 text-[11px] font-medium tracking-[0.06em] text-secondary-foreground uppercase">
            {PRICING.trialDays}-day Pro trial
          </span>
        )}
      </div>
      <p className={cn('mt-1.5 min-h-10 text-[14.5px] leading-snug', muted)}>{tier.summary}</p>

      <div className="mt-6 flex items-baseline gap-2">
        <span className="serif-display text-[3.25rem] tabular-nums">
          {tier.id === 'pro' ? formatPrice(proPerMonth(billing)) : '$0'}
        </span>
        <span className={cn('text-[14px]', muted)}>
          {tier.id === 'pro'
            ? billing === 'monthly'
              ? 'a month'
              : `a month, ${formatPrice(PRICING.proYearly)} billed yearly`
            : tier.id === 'free'
              ? 'after the trial'
              : 'no account'}
        </span>
      </div>

      <ul className="mt-7 flex-1 space-y-3">
        {tier.features.map((feature) => (
          <li key={feature} className="flex gap-3 text-[14.5px] leading-relaxed">
            <span
              aria-hidden
              className={cn(
                'mt-2.5 inline-flex size-1.5 shrink-0 rounded-full',
                ink ? 'bg-primary-foreground/60' : 'bg-foreground/50'
              )}
            />
            <span className={ink ? 'text-primary-foreground/90' : 'text-foreground/85'}>
              {feature}
            </span>
          </li>
        ))}
      </ul>

      <ButtonLink
        href={tier.cta.href}
        variant={ink ? 'inverse' : tier.id === 'free' ? 'primary' : 'secondary'}
        className="mt-8 w-full"
      >
        {tier.cta.label}
      </ButtonLink>
    </Surface>
  )
}
