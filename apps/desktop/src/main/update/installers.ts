import { spawn } from 'node:child_process'
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { InstallKind } from '@shared/updates'
import type { Logger } from '../logger'

export interface InstallContext {
  log: Logger
  platform: NodeJS.Platform
  env: Record<string, string | undefined>
  execPath: string
  resourcesPath: string
  pid: number
  currentVersion: string
  /** Scratch space on the same volume as the download (cleaned on the next start). */
  workDir: string
}

/** Relaunch argument: the app starts hidden unless the window was open before the update. */
export const UPDATED_FLAG = '--updated'

export class ManualInstallError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ManualInstallError'
  }
}

/**
 * Apply a verified update file. Resolves once the new version is in place and the relaunch has
 * been arranged; the caller must quit the app right after. Throws when the update could not be
 * applied, in which case nothing has been replaced and the download is still usable by hand.
 */
export async function applyUpdate(
  kind: InstallKind,
  file: string,
  ctx: InstallContext
): Promise<void> {
  switch (kind) {
    case 'nsis':
      return installNsis(file, ctx)
    case 'appimage':
      return installAppImage(file, ctx)
    case 'deb':
      return installDeb(file, ctx)
    case 'mac':
      return installMac(file, ctx)
    default:
      throw new ManualInstallError('This copy of Murmur cannot update itself; open the download.')
  }
}

// ---- Windows (NSIS) -----------------------------------------------------------------------------

/**
 * Run the new installer silently. `--updated` tells electron-builder's NSIS script this is an
 * upgrade (it waits for / closes the running app and skips the wizard pages), `--force-run`
 * relaunches Murmur afterwards. Per-machine installs need elevation, which electron-builder
 * bundles as resources/elevate.exe.
 */
function installNsis(file: string, ctx: InstallContext): void {
  const args = ['/S', UPDATED_FLAG, '--force-run']
  const perMachine = !isWritable(dirname(ctx.execPath))
  const elevate = join(ctx.resourcesPath, 'elevate.exe')
  let command = file
  let commandArgs = args
  if (perMachine && existsSync(elevate)) {
    command = elevate
    commandArgs = [file, ...args]
  }
  ctx.log.info(`launching installer: ${command} ${commandArgs.join(' ')}`)
  const child = spawn(command, commandArgs, { detached: true, stdio: 'ignore', windowsHide: true })
  child.on('error', (err) => ctx.log.error('installer failed to start', err))
  child.unref()
}

// ---- Linux AppImage -----------------------------------------------------------------------------

/**
 * Replace the running AppImage. Renaming over a mounted AppImage is safe: the FUSE mount keeps the
 * old inode alive until we exit. A file the user renamed (install.sh saves it as `murmur`) keeps
 * its name; a versioned file name gets the new version's name and the old file is removed.
 */
function installAppImage(file: string, ctx: InstallContext): void {
  const current = ctx.env.APPIMAGE
  if (!current || !existsSync(current)) {
    throw new ManualInstallError('Could not find the running AppImage to replace.')
  }
  const dir = dirname(current)
  if (!isWritable(dir)) {
    throw new ManualInstallError(`${dir} is not writable; replace the AppImage by hand.`)
  }
  const currentName = basename(current)
  const target = currentName.includes(ctx.currentVersion) ? join(dir, basename(file)) : current
  const staging = join(dir, `.${currentName}.update-${ctx.pid}`)
  try {
    copyFileSync(file, staging)
    chmodSync(staging, 0o755)
    renameSync(staging, target)
  } catch (err) {
    rmSync(staging, { force: true })
    throw err
  }
  if (target !== current) {
    try {
      unlinkSync(current)
    } catch (err) {
      ctx.log.warn(`could not remove the previous AppImage ${current}`, err)
    }
  }
  ctx.log.info(`AppImage updated: ${target}`)
  relaunchAfterExit(target, [UPDATED_FLAG], ctx)
}

// ---- Linux .deb ---------------------------------------------------------------------------------

/** Install the package through polkit (`pkexec`), then relaunch the (now replaced) binary. */
async function installDeb(file: string, ctx: InstallContext): Promise<void> {
  const result = await runCommand('pkexec', ['dpkg', '-i', file], ctx)
  if (result.code === 'ENOENT') {
    throw new ManualInstallError(
      `pkexec is not available; install with: sudo apt install ${quoteShell(file)}`
    )
  }
  if (result.exitCode === 126) throw new ManualInstallError('Authentication was cancelled.')
  if (result.exitCode === 127) throw new ManualInstallError('Not authorised to install packages.')
  if (result.exitCode !== 0) {
    throw new Error(`dpkg failed (exit ${result.exitCode}): ${result.stderr.trim().slice(-400)}`)
  }
  ctx.log.info('deb installed')
  relaunchAfterExit(ctx.execPath, [UPDATED_FLAG], ctx)
}

// ---- macOS --------------------------------------------------------------------------------------

/**
 * Swap the app bundle: extract the release .zip with ditto (keeps signatures and resource forks),
 * move the running bundle aside, move the new one into place, relaunch through LaunchServices.
 */
async function installMac(file: string, ctx: InstallContext): Promise<void> {
  const appPath = resolve(ctx.execPath, '..', '..', '..')
  if (!appPath.endsWith('.app')) throw new ManualInstallError('Not running from an app bundle.')
  const parent = dirname(appPath)
  if (!isWritable(parent)) {
    throw new ManualInstallError(
      `${parent} is not writable; drag the new Murmur.app there by hand.`
    )
  }
  const staging = mkdtempSync(join(ctx.workDir, 'mac-'))
  const extracted = await runCommand('ditto', ['-x', '-k', file, staging], ctx)
  if (extracted.exitCode !== 0) throw new Error(`Could not extract the update: ${extracted.stderr}`)
  const bundle = readdirSync(staging).find((name) => name.endsWith('.app'))
  const newApp = bundle ? join(staging, bundle) : null
  if (!newApp || !existsSync(join(newApp, 'Contents', 'MacOS'))) {
    throw new Error('The update archive does not contain an app bundle.')
  }
  const previous = join(staging, 'previous.app')
  renameSync(appPath, previous)
  try {
    renameSync(newApp, appPath)
  } catch (err) {
    // Different volume: copy instead, and put the old bundle back if even that fails.
    const copied = await runCommand('ditto', [newApp, appPath], ctx)
    if (copied.exitCode !== 0) {
      renameSync(previous, appPath)
      throw err
    }
  }
  await runCommand('xattr', ['-dr', 'com.apple.quarantine', appPath], ctx)
  ctx.log.info(`app bundle replaced: ${appPath}`)
  relaunchAfterExit('open', ['-n', appPath, '--args', UPDATED_FLAG], ctx)
}

// ---- helpers ------------------------------------------------------------------------------------

function isWritable(path: string): boolean {
  try {
    accessSync(path, fsConstants.W_OK)
    return true
  } catch {
    return false
  }
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Start the new version once this process has exited, so the single-instance lock is free. A
 * detached shell polls our pid; it survives us because it is its own session.
 *
 * Chromium opens its files without O_CLOEXEC, so the shell inherits descriptors into the old
 * AppImage mount; left open they would keep that mount (and the deleted old file) alive for as
 * long as the new instance runs. bash can close arbitrary descriptors, dash cannot, hence the
 * preference; without bash the relaunch still works, the old mount just lingers until quit.
 */
function relaunchAfterExit(command: string, args: string[], ctx: InstallContext): void {
  const exec = [command, ...args].map(quoteShell).join(' ')
  const closeInherited =
    'if [ -n "$BASH_VERSION" ] && [ -d /proc/self/fd ]; then ' +
    'for fd in $(ls /proc/self/fd); do [ "$fd" -gt 2 ] && eval "exec $fd>&-" 2>/dev/null; done; ' +
    'fi; '
  const script = `${closeInherited}while kill -0 ${ctx.pid} 2>/dev/null; do sleep 0.2; done; exec ${exec}`
  const shell = existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh'
  // Drop the AppImage runtime's variables (and its PATH entries) so the new runtime sets its own.
  const env = { ...ctx.env }
  const appDir = env.APPDIR
  for (const key of ['APPIMAGE', 'APPDIR', 'OWD', 'ARGV0']) delete env[key]
  if (appDir && env.PATH) {
    env.PATH = env.PATH.split(':')
      .filter((entry) => !entry.startsWith(appDir))
      .join(':')
  }
  const child = spawn(shell, ['-c', script], { detached: true, stdio: 'ignore', env })
  child.on('error', (err) => ctx.log.error('relauncher failed to start', err))
  child.unref()
}

interface CommandResult {
  exitCode: number | null
  stderr: string
  code?: string
}

function runCommand(command: string, args: string[], ctx: InstallContext): Promise<CommandResult> {
  return new Promise((resolvePromise) => {
    let stderr = ''
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], env: ctx.env })
    } catch (err) {
      resolvePromise({ exitCode: null, stderr: String(err), code: (err as { code?: string }).code })
      return
    }
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('error', (err: NodeJS.ErrnoException) => {
      resolvePromise({ exitCode: null, stderr: err.message, code: err.code })
    })
    child.on('close', (exitCode) => resolvePromise({ exitCode, stderr }))
  })
}
