import { NextResponse } from 'next/server'
import { DOWNLOAD_PLATFORMS, isDownloadPlatform, stableDownloadUrl } from '@/lib/releases'

/**
 * GET /download/{windows|linux|android}: redirect to the file most people want on that platform
 * (the combined Windows installer, the x64 AppImage, the APK) through GitHub's stable alias,
 * https://github.com/<repo>/releases/latest/download/<alias>, which GitHub resolves to the current
 * stable release on every request. The redirect never names a version, so this route is plain
 * static output: no GitHub API call, nothing to revalidate, correct the moment a release is
 * published, on any host and any plan.
 *
 * It used to redirect to the versioned asset from the release manifest and revalidate every ten
 * minutes. Prerendered per platform, each path revalidated on its own schedule behind an hour of
 * stale-while-revalidate, so after v0.5.0 shipped /download/android kept sending people the
 * debug-signed 0.4.0 APK long after the manifest and the other two redirects had moved on.
 */
export const dynamic = 'force-static'
export const dynamicParams = false

export function generateStaticParams(): Array<{ platform: string }> {
  return DOWNLOAD_PLATFORMS.map((platform) => ({ platform }))
}

export async function GET(_request: Request, ctx: { params: Promise<{ platform: string }> }) {
  const { platform } = await ctx.params
  if (!isDownloadPlatform(platform)) return new Response(null, { status: 404 })
  return NextResponse.redirect(stableDownloadUrl(platform), {
    status: 302,
    // The target only changes if the repository or the catalog does, i.e. with a deploy.
    headers: { 'cache-control': 'public, max-age=3600, s-maxage=86400' }
  })
}
