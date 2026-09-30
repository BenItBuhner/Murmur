/**
 * The public configuration of the accounts feature. Next inlines NEXT_PUBLIC_* variables into the
 * client bundle only when they are read by their literal names, hence no dynamic lookups here.
 * Everything else on the site works without any of them.
 */
export const clerkPublishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim() ?? ''
export const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL?.trim() ?? ''

/** The feature switch's value semantics, shared with the backend's `billingEnabled`: the literal `true`. */
export function readBillingFlag(value: string | undefined): boolean {
  return (value ?? '').trim().toLowerCase() === 'true'
}

/**
 * Whether the site presents Pro as something to buy: the pricing page and its links, the trial and
 * Pro copy on the landing and legal pages, the billing sections of the terms. The build-time twin
 * of the backend's `MURMUR_BILLING_ENABLED` (`NEXT_PUBLIC_MURMUR_BILLING_ENABLED`, from the same
 * repository variable); the account page follows the backend's answer at runtime instead, since
 * that is what decides whether Checkout would actually open. Off by default.
 */
export const billingEnabled = readBillingFlag(process.env.NEXT_PUBLIC_MURMUR_BILLING_ENABLED)

export type AccountsSetup =
  | { configured: true }
  | {
      configured: false
      missing: Array<'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY' | 'NEXT_PUBLIC_CONVEX_URL'>
    }

export function accountsSetup(): AccountsSetup {
  const missing: Array<'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY' | 'NEXT_PUBLIC_CONVEX_URL'> = []
  if (!clerkPublishableKey) missing.push('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY')
  if (!convexUrl) missing.push('NEXT_PUBLIC_CONVEX_URL')
  return missing.length ? { configured: false, missing } : { configured: true }
}
