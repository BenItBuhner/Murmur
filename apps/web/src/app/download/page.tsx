import type { Metadata } from 'next'
import { AssetList } from '@/components/download/asset-list'
import { InstallCommands } from '@/components/download/install-commands'
import { PlatformDownloadButton } from '@/components/platform-download'
import { PageHeader, Section } from '@/components/ui/section'
import { formatDate } from '@/lib/format'
import { DOWNLOAD_PLATFORMS, fetchLatestRelease } from '@/lib/releases'
import { latestDownloadBase, releasesUrl } from '@/lib/site'

export const metadata: Metadata = {
  title: 'Download',
  description:
    'Download Murmur for Windows, Linux and Android: installers, AppImage, .deb and APK from the latest release, with checksums and one-line installers.'
}

/* Prerendered; the release list refreshes from GitHub every ten minutes (REVALIDATE_SECONDS). */
export const revalidate = 600

const LINK =
  'text-foreground/80 underline decoration-foreground/30 underline-offset-4 hover:text-foreground'

export default async function DownloadPage() {
  const manifest = await fetchLatestRelease()
  return (
    <>
      <Section className="pb-10">
        <PageHeader
          eyebrow="Download"
          title={
            manifest ? (
              <>
                Murmur <span className="tabular-nums">{manifest.version}</span>
              </>
            ) : (
              'The latest Murmur'
            )
          }
          lede={
            manifest ? (
              <>
                {manifest.publishedAt && <>Released {formatDate(manifest.publishedAt)}. </>}
                Both apps update themselves from here on: you download Murmur by hand once.
              </>
            ) : (
              <>
                GitHub could not be reached just now, so versions and sizes are missing. Every link
                below still resolves to the current release.
              </>
            )
          }
          meta={
            manifest ? (
              <>
                <a href={manifest.url} className={LINK}>
                  Release notes
                </a>
                {' · '}
                <a href={manifest.releasesUrl} className={LINK}>
                  All releases
                </a>
                {manifest.checksumsUrl && (
                  <>
                    {' · '}
                    <a href={manifest.checksumsUrl} className={LINK}>
                      SHA256SUMS.txt
                    </a>
                  </>
                )}
              </>
            ) : (
              <>
                <a href={releasesUrl()} className={LINK}>
                  All releases
                </a>
                {' · '}
                <a href={`${latestDownloadBase()}/SHA256SUMS.txt`} className={LINK}>
                  SHA256SUMS.txt
                </a>
              </>
            )
          }
        />
        {/* One button per platform, each a third of the width: the row is as wide as the lists. */}
        <div className="mt-section grid gap-3 sm:grid-cols-3">
          {DOWNLOAD_PLATFORMS.map((platform) => (
            <PlatformDownloadButton
              key={platform}
              manifest={manifest}
              platform={platform}
              size="lg"
              className="w-full"
            />
          ))}
        </div>
      </Section>

      <Section className="pt-0 sm:pt-0">
        {/*
         * Two columns of list cards at desktop sizes: Windows beside Linux, then Android with the
         * one-line installers under it beside macOS, so the columns end close together. Below lg
         * everything stacks in that order.
         */}
        <div className="grid gap-card lg:grid-cols-2 lg:items-start">
          <AssetList manifest={manifest} platform="windows" />
          <AssetList manifest={manifest} platform="linux" />
          <div className="grid gap-card">
            <AssetList manifest={manifest} platform="android" />
            <InstallCommands manifest={manifest} />
          </div>
          <AssetList manifest={manifest} platform="macos" />
        </div>
        <p className="mt-8 max-w-3xl text-note text-muted-foreground">
          Every release ships a SHA256SUMS.txt; the apps verify each update against it before
          installing and refuse to install unattended without one.
          {manifest?.localOnly && (
            <>
              {' '}
              This release is a local-only build: accounts and Murmur’s models are not in it yet, so
              connect a speech model of your own and everything stays on the device.
            </>
          )}
        </p>
      </Section>
    </>
  )
}
