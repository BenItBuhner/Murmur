import { ButtonLink } from '@/components/ui/button'
import { Surface } from '@/components/ui/surface'
import type { AccountsSetup } from '@/lib/env'

/** What /account shows on a deployment without a Murmur instance behind it. */
export function AccountUnavailable({
  setup
}: {
  setup: Extract<AccountsSetup, { configured: false }>
}) {
  return (
    <div className="grid items-start gap-5 lg:grid-cols-[1.2fr_0.8fr]">
      <Surface radius={32} padding={24}>
        <h2 className="serif-display text-[2rem]">Accounts are not switched on here yet</h2>
        <p className="mt-3 text-[15px] leading-relaxed text-muted-foreground">
          This copy of the site is not connected to a Murmur instance, so there is nothing to sign
          in to. The apps work without an account: connect a speech model of your own under Models
          and everything stays on the device.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <ButtonLink href="/download">Download Murmur</ButtonLink>
          <ButtonLink href="/pricing" variant="secondary">
            What an account adds
          </ButtonLink>
        </div>
      </Surface>
      <Surface radius={32} padding={20} level="inset">
        <div className="eyebrow px-1">For the operator</div>
        <p className="mt-2 px-1 text-[13.5px] leading-relaxed text-muted-foreground">
          Set these on the deployment and this page becomes the sign-in and account view for the
          Clerk application and Convex deployment the apps use:
        </p>
        <ul className="mt-3 grid gap-1.5">
          {setup.missing.map((name) => (
            <li
              key={name}
              className="rounded-(--ri) bg-card px-3 py-2 font-mono text-[12.5px] shadow-raised"
            >
              {name}
            </li>
          ))}
        </ul>
      </Surface>
    </div>
  )
}
