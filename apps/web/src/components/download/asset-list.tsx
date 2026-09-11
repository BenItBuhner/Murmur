import { Surface } from '@/components/ui/surface'
import { formatBytes } from '@/lib/format'
import { ASSET_CATALOG, PLATFORM_LABELS, type Platform, type ReleaseManifest } from '@/lib/releases'
import { latestDownloadBase } from '@/lib/site'

const NOTES: Record<Platform, string> = {
  windows:
    'Run the installer, or use the portable .exe without installing. The build is not code-signed yet, so SmartScreen may ask: choose More info, then Run anyway.',
  linux:
    'chmod +x the AppImage and run it, or sudo apt install the .deb. Murmur follows your desktop’s accent colour on GNOME 47+ and KDE.',
  android:
    'Install the APK (allow installs from your browser if asked), then enable the Murmur accessibility service and “display over other apps” from the setup screen. Updates install themselves from then on.',
  macos:
    'Experimental. Open the .dmg and drag Murmur to Applications, then grant Microphone and Accessibility access. The build is not notarized: right-click, then Open.'
}

const ARCH_LABEL = { x64: 'x64', arm64: 'arm64', universal: 'x64 + arm64' } as const

/** Every file a platform gets on the latest release, or the stable aliases when the release is unknown. */
export function AssetList({
  manifest,
  platform
}: {
  manifest: ReleaseManifest | null
  platform: Platform
}) {
  const rows = manifest
    ? manifest.platforms[platform].assets.map((asset) => ({
        key: asset.name,
        label: asset.label,
        group: asset.group,
        arch: ARCH_LABEL[asset.arch],
        size: formatBytes(asset.size),
        href: asset.url,
        stableHref: asset.stableUrl,
        recommended: asset.recommended
      }))
    : ASSET_CATALOG.filter((entry) => entry.platform === platform).map((entry) => ({
        key: entry.alias,
        label: entry.label,
        group: entry.group,
        arch: ARCH_LABEL[entry.arch],
        size: null,
        href: `${latestDownloadBase()}/${entry.alias}`,
        stableHref: null,
        recommended: entry.recommended === true
      }))

  return (
    <Surface radius={32} padding={20} id={platform} className="scroll-mt-24">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 px-1">
        <h2 className="serif-display text-[2rem]">{PLATFORM_LABELS[platform]}</h2>
        {platform === 'macos' && (
          <span className="rounded-full bg-secondary px-2.5 py-1 text-[11px] font-medium tracking-[0.06em] text-secondary-foreground uppercase">
            experimental
          </span>
        )}
      </div>
      <p className="mt-2 px-1 text-[14px] leading-relaxed text-muted-foreground">
        {NOTES[platform]}
      </p>

      <ul className="mt-5 grid gap-2">
        {rows.map((row) => (
          <li
            key={row.key}
            className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 rounded-(--ri) bg-secondary px-4 py-3 sm:grid-cols-[1fr_5.5rem_5rem_auto]"
          >
            <div className="min-w-0">
              <div className="truncate text-[14.5px] font-medium">
                {row.group}
                <span className="text-muted-foreground"> · {row.label}</span>
                {row.recommended && (
                  <span className="ml-2 align-middle rounded-full bg-card px-2 py-0.5 text-[10.5px] font-medium tracking-[0.06em] text-muted-foreground uppercase shadow-raised">
                    recommended
                  </span>
                )}
              </div>
              <div className="mt-0.5 truncate text-[12.5px] text-muted-foreground sm:hidden">
                {row.arch}
                {row.size ? ` · ${row.size}` : ''}
              </div>
            </div>
            <span className="hidden text-[13px] text-muted-foreground tabular-nums sm:block">
              {row.arch}
            </span>
            <span className="hidden text-[13px] text-muted-foreground tabular-nums sm:block">
              {row.size ?? 'latest'}
            </span>
            <div className="flex items-center gap-1.5">
              <a
                href={row.href}
                rel="noreferrer"
                className="inline-flex h-8 items-center rounded-full bg-primary px-3.5 text-[13px] font-medium text-primary-foreground transition-colors duration-200 hover:bg-primary/88"
              >
                Download
              </a>
              {row.stableHref && (
                <a
                  href={row.stableHref}
                  rel="noreferrer"
                  title="A link that always resolves to the latest release"
                  className="hidden h-8 items-center rounded-full px-3 text-[13px] font-medium text-muted-foreground transition-colors duration-200 hover:bg-card hover:text-foreground sm:inline-flex"
                >
                  Always latest
                </a>
              )}
            </div>
          </li>
        ))}
      </ul>
    </Surface>
  )
}
