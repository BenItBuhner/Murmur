import Link from 'next/link'
import { ButtonLink } from '@/components/ui/button'
import { Container } from '@/components/ui/section'
import { Wordmark } from '@/components/wordmark'
import { navLinks } from '@/lib/site'

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 bg-background/85 backdrop-blur-md supports-[backdrop-filter]:bg-background/70">
      <Container className="flex h-16 items-center justify-between gap-4">
        <Link
          href="/"
          className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/35"
          aria-label="Murmur home"
        >
          <Wordmark />
        </Link>

        {/* Download is the header's primary button, so the link list leaves it out; the footer keeps the full list. */}
        <nav className="hidden items-center gap-1 md:flex" aria-label="Primary">
          {navLinks()
            .filter((item) => item.href !== '/download')
            .map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="rounded-full px-3.5 py-1.5 text-note font-medium text-muted-foreground transition-colors duration-200 hover:bg-accent hover:text-foreground"
              >
                {item.label}
              </Link>
            ))}
        </nav>

        <div className="flex items-center gap-2">
          <ButtonLink href="/account" variant="ghost" size="sm">
            Account
          </ButtonLink>
          <ButtonLink href="/download" size="sm">
            Download
          </ButtonLink>
        </div>
      </Container>
    </header>
  )
}
