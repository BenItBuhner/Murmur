import { Surface } from '@/components/ui/surface'
import type { ReleaseManifest } from '@/lib/releases'
import { latestDownloadBase } from '@/lib/site'

/** The one-line installers the release workflow uploads next to every release. */
export function InstallCommands({ manifest }: { manifest: ReleaseManifest | null }) {
  const base = latestDownloadBase()
  const sh = manifest?.install.sh ?? `${base}/install.sh`
  const ps1 = manifest?.install.ps1 ?? `${base}/install.ps1`
  const commands = [
    { label: 'Linux and macOS', code: `curl -fsSL ${sh} | bash` },
    { label: 'Windows (PowerShell)', code: `irm ${ps1} | iex` }
  ]
  return (
    <Surface radius={32} padding={20}>
      <div className="px-1">
        <h2 className="serif-display text-[2rem]">Install in one command</h2>
        <p className="mt-2 text-[14px] leading-relaxed text-muted-foreground">
          The scripts pick the right file for your machine from the latest release and verify it
          against the release’s checksums before installing.
        </p>
      </div>
      <div className="mt-5 grid gap-2">
        {commands.map((c) => (
          <div
            key={c.label}
            className="rounded-(--ri) bg-primary px-4 py-3.5 text-primary-foreground"
          >
            <div className="text-[11px] font-medium tracking-[0.1em] text-primary-foreground/60 uppercase">
              {c.label}
            </div>
            <pre className="mt-1.5 overflow-x-auto font-mono text-[13px] leading-relaxed">
              <code>{c.code}</code>
            </pre>
          </div>
        ))}
      </div>
    </Surface>
  )
}
