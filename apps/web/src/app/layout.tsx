import type { Metadata, Viewport } from 'next'
import { Inter, Inter_Tight, Instrument_Serif } from 'next/font/google'
import type { ReactNode } from 'react'
import { SiteFooter } from '@/components/site-footer'
import { SiteHeader } from '@/components/site-header'
import { SITE_DESCRIPTION, SITE_NAME, SITE_TAGLINE, siteUrl } from '@/lib/site'
import './globals.css'

/*
 * Inter is the apps' body face. The site sets headlines in Inter Tight and keeps Instrument Serif,
 * the apps' display face, for one italic accent word per headline.
 */
const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' })
const interTight = Inter_Tight({
  subsets: ['latin'],
  weight: ['500', '600', '700'],
  variable: '--font-inter-tight',
  display: 'swap'
})
const instrumentSerif = Instrument_Serif({
  subsets: ['latin'],
  weight: '400',
  style: ['normal', 'italic'],
  variable: '--font-instrument-serif',
  display: 'swap'
})

export const metadata: Metadata = {
  metadataBase: siteUrl(),
  title: {
    default: `${SITE_NAME}: ${SITE_TAGLINE}`,
    template: `%s · ${SITE_NAME}`
  },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  openGraph: {
    type: 'website',
    siteName: SITE_NAME,
    title: `${SITE_NAME}: voice dictation for Windows, Linux and Android`,
    description: SITE_DESCRIPTION
  },
  twitter: { card: 'summary' }
}

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#0e0c16' },
    { media: '(prefers-color-scheme: dark)', color: '#0e0c16' }
  ],
  width: 'device-width',
  initialScale: 1
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${interTight.variable} ${instrumentSerif.variable} h-full`}
    >
      <body className="flex min-h-full flex-col">
        <SiteHeader />
        <main className="flex-1">{children}</main>
        <SiteFooter />
      </body>
    </html>
  )
}
