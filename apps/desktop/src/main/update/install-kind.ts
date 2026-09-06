import { dirname, join } from 'node:path'
import type { InstallKind } from '@shared/updates'

export interface InstallProbe {
  platform: NodeJS.Platform
  isPackaged: boolean
  env: Record<string, string | undefined>
  execPath: string
  resourcesPath: string
  exists: (path: string) => boolean
  readText: (path: string) => string | null
}

/** electron-builder names the NSIS uninstaller after the product. */
export const NSIS_UNINSTALLER = 'Uninstall Murmur.exe'

/**
 * Work out which release artifact this process came from. Every signal here is something the
 * packaging tools set for us: the portable launcher exports PORTABLE_EXECUTABLE_FILE, the AppImage
 * runtime exports APPIMAGE, electron-builder drops `resources/package-type` into .deb/.rpm builds,
 * NSIS installs ship their uninstaller next to the exe, and macOS bundles have a fixed layout.
 */
export function detectInstallKind(probe: InstallProbe): InstallKind {
  if (!probe.isPackaged) return 'dev'
  switch (probe.platform) {
    case 'win32':
      if (probe.env.PORTABLE_EXECUTABLE_FILE || probe.env.PORTABLE_EXECUTABLE_DIR) return 'portable'
      return probe.exists(join(dirname(probe.execPath), NSIS_UNINSTALLER)) ? 'nsis' : 'unknown'
    case 'linux': {
      if (probe.env.APPIMAGE) return 'appimage'
      const packageType = probe.readText(join(probe.resourcesPath, 'package-type'))?.trim()
      return packageType === 'deb' ? 'deb' : 'unknown'
    }
    case 'darwin':
      return /\.app\/Contents\/MacOS\/[^/]+$/.test(probe.execPath) ? 'mac' : 'unknown'
    default:
      return 'unknown'
  }
}

export { kindCanSelfUpdate } from '@shared/updates'
