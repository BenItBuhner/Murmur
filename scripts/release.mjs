#!/usr/bin/env node
// Release tooling for the Murmur monorepo. No dependencies; Node 22+.
//
//   node scripts/release.mjs <version> [--dry-run] [--no-git]
//     Bump every version file to <version>, regenerate the README download table, commit
//     "chore(release): v<version>" and create the annotated tag v<version>. Pushing that tag
//     triggers .github/workflows/release.yml, which builds every platform and publishes the release.
//
//   node scripts/release.mjs check [--tag v<version>]
//     Verify that all version files agree (and match the given tag). Used by CI.
//
//   node scripts/release.mjs notes <version> <assets-dir>
//     Print release-notes markdown (download table + install notes) for the files in <assets-dir>.
//     Used by the release workflow to fill in the GitHub release body.
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const FILES = {
  rootPackage: resolve(ROOT, 'package.json'),
  desktopPackage: resolve(ROOT, 'apps/desktop/package.json'),
  desktopLock: resolve(ROOT, 'apps/desktop/package-lock.json'),
  androidGradle: resolve(ROOT, 'apps/android/app/build.gradle.kts'),
  readme: resolve(ROOT, 'README.md')
}

// Semver without build metadata ("+..."), since the version ends up in tags and file names.
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/
const GRADLE_VERSION_RE = /^val murmurVersion = "([^"]*)"$/m
const README_BLOCK_RE = /<!-- downloads:start v(\S+) -->[\s\S]*?<!-- downloads:end -->/

/**
 * Every file a release ships, in display order. File names must match the artifactName patterns
 * in apps/desktop/electron-builder.yml and the Android step of .github/workflows/release.yml.
 * Quirks worth knowing: NSIS emits a combined x64+arm64 installer in addition to the per-arch
 * ones when the pattern contains ${arch}, and .deb / AppImage use Debian arch names (amd64, x86_64).
 */
const ASSETS = [
  { group: 'Windows', label: 'Installer (x64 + arm64)', file: (v) => `Murmur-${v}-setup.exe` },
  { group: 'Windows', label: 'Portable (x64)', file: (v) => `Murmur-${v}-portable.exe` },
  { group: 'Windows x64 only', label: 'Installer', file: (v) => `Murmur-${v}-x64-setup.exe` },
  { group: 'Windows arm64 only', label: 'Installer', file: (v) => `Murmur-${v}-arm64-setup.exe` },
  { group: 'Linux x64', label: 'AppImage', file: (v) => `Murmur-${v}-x86_64.AppImage` },
  { group: 'Linux x64', label: '.deb', file: (v) => `murmur_${v}_amd64.deb` },
  { group: 'Linux arm64', label: 'AppImage', file: (v) => `Murmur-${v}-arm64.AppImage` },
  { group: 'Linux arm64', label: '.deb', file: (v) => `murmur_${v}_arm64.deb` },
  { group: 'macOS (Apple silicon)', label: '.dmg', file: (v) => `Murmur-${v}-arm64.dmg` },
  { group: 'macOS (Apple silicon)', label: '.zip', file: (v) => `Murmur-${v}-arm64.zip` },
  { group: 'macOS (Intel)', label: '.dmg', file: (v) => `Murmur-${v}-x64.dmg` },
  { group: 'macOS (Intel)', label: '.zip', file: (v) => `Murmur-${v}-x64.zip` },
  { group: 'Android', label: 'APK', file: (v) => `Murmur-${v}-android.apk` }
]
const CHECKSUMS_FILE = 'SHA256SUMS.txt'

// ---- helpers ----------------------------------------------------------------------------------

function fail(message) {
  console.error(`error: ${message}`)
  process.exit(1)
}

function warn(message) {
  // "::warning::" renders as an annotation in GitHub Actions and is harmless elsewhere.
  console.error(process.env.GITHUB_ACTIONS ? `::warning::${message}` : `warning: ${message}`)
}

function rel(path) {
  return relative(ROOT, path)
}

function git(...args) {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

function parseSemver(version) {
  const match = SEMVER_RE.exec(version)
  if (!match) fail(`"${version}" is not a valid version (expected X.Y.Z or X.Y.Z-pre.N)`)
  const [, major, minor, patch, prerelease] = match
  // The Android versionCode packs minor/patch into two digits each (see build.gradle.kts).
  if (Number(minor) > 99 || Number(patch) > 99) {
    fail(`minor and patch must be below 100 so the Android versionCode stays monotonic: ${version}`)
  }
  return { major: Number(major), minor: Number(minor), patch: Number(patch), prerelease }
}

function detectRepo() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY
  let url = ''
  try {
    url = git('remote', 'get-url', 'origin')
  } catch {
    // handled below
  }
  const match = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url)
  if (!match) fail('cannot determine the GitHub repository; set GITHUB_REPOSITORY=owner/name')
  return match[1]
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function readText(path) {
  return readFileSync(path, 'utf8')
}

/** Current version according to every file that carries one. Keys are repo-relative paths. */
function readVersions() {
  const lock = readJson(FILES.desktopLock)
  const gradle = GRADLE_VERSION_RE.exec(readText(FILES.androidGradle))
  const readme = README_BLOCK_RE.exec(readText(FILES.readme))
  return {
    [rel(FILES.rootPackage)]: readJson(FILES.rootPackage).version,
    [rel(FILES.desktopPackage)]: readJson(FILES.desktopPackage).version,
    [`${rel(FILES.desktopLock)} (version)`]: lock.version,
    [`${rel(FILES.desktopLock)} (packages[""])`]: lock.packages?.['']?.version,
    [`${rel(FILES.androidGradle)} (murmurVersion)`]: gradle?.[1],
    [`${rel(FILES.readme)} (downloads block)`]: readme?.[1]
  }
}

// ---- markdown ---------------------------------------------------------------------------------

function downloadBase(repo, version) {
  return `https://github.com/${repo}/releases/download/v${version}`
}

/** Markdown table of download links, restricted to `present` files when given. */
function downloadTable(repo, version, present = null) {
  const base = downloadBase(repo, version)
  const rows = new Map()
  for (const asset of ASSETS) {
    const file = asset.file(version)
    if (present && !present.has(file)) continue
    const links = rows.get(asset.group) ?? []
    links.push(`[${asset.label}](${base}/${file})`)
    rows.set(asset.group, links)
  }
  const lines = ['| Platform | Download |', '| --- | --- |']
  for (const [group, links] of rows) lines.push(`| ${group} | ${links.join(' · ')} |`)
  return lines.join('\n')
}

/** The block kept up to date in README.md between the downloads markers. */
function readmeBlock(repo, version) {
  const tag = `v${version}`
  const releases = `https://github.com/${repo}/releases`
  return [
    `<!-- downloads:start ${tag} -->`,
    '<!-- Generated by `npm run release`; edit scripts/release.mjs instead of this block. -->',
    `**Latest release: [${tag}](${releases}/tag/${tag})** · [All releases](${releases}) · [Checksums](${releases}/download/${tag}/${CHECKSUMS_FILE})`,
    '',
    downloadTable(repo, version),
    '<!-- downloads:end -->'
  ].join('\n')
}

function installNotes(groups, signed) {
  const notes = []
  const has = (platform) => [...groups].some((g) => g.startsWith(platform))
  if (has('Windows')) {
    let note = '**Windows** — run the installer, or use the portable `.exe` without installing.'
    if (!signed.windows) {
      note +=
        ' This build is not code-signed, so SmartScreen may warn about an unknown publisher: choose **More info → Run anyway**.'
    }
    notes.push(note)
  }
  if (has('Linux')) {
    notes.push(
      '**Linux** — `chmod +x Murmur-*.AppImage && ./Murmur-*.AppImage`, or `sudo apt install ./murmur_*.deb`.'
    )
  }
  if (has('macOS')) {
    let note =
      '**macOS** — open the `.dmg`, drag Murmur to Applications, then grant Microphone and Accessibility access when asked.'
    if (!signed.mac) {
      note +=
        ' This build is not notarized, so macOS may refuse to open it: right-click → **Open**, or run `xattr -dr com.apple.quarantine /Applications/Murmur.app`.'
    }
    notes.push(note)
  }
  if (has('Android')) {
    let note =
      '**Android** — install the APK (allow installs from your browser or file manager if prompted), then enable the Murmur accessibility service and "display over other apps" from the setup screen.'
    if (!signed.android) {
      note +=
        ' **Note:** this APK is signed with a debug key. It works for testing, but a future release-signed build cannot update it in place.'
    }
    notes.push(note)
  }
  return notes.map((n) => `- ${n}`)
}

/** Release body for the GitHub release, describing the assets actually found in `dir`. */
function releaseNotes(repo, version, dir) {
  const present = new Set(readdirSync(dir))
  const expected = new Set(ASSETS.map((a) => a.file(version)))
  for (const file of expected)
    if (!present.has(file)) warn(`expected release asset is missing: ${file}`)
  const other = [...present].filter((f) => !expected.has(f) && f !== CHECKSUMS_FILE).sort()
  const groups = new Set(ASSETS.filter((a) => present.has(a.file(version))).map((a) => a.group))
  const signed = {
    windows: process.env.MURMUR_WIN_SIGNED === 'true',
    mac: process.env.MURMUR_MAC_SIGNED === 'true',
    android: process.env.MURMUR_ANDROID_RELEASE_KEY === 'true'
  }
  const base = downloadBase(repo, version)

  const md = ['## Downloads', '', downloadTable(repo, version, present)]
  if (other.length) {
    md.push('', `Other files: ${other.map((f) => `[${f}](${base}/${f})`).join(' · ')}`)
  }
  md.push('', '## Installing', '', ...installNotes(groups, signed))
  if (present.has(CHECKSUMS_FILE)) {
    md.push(
      '',
      '## Verify a download',
      '',
      `Save [${CHECKSUMS_FILE}](${base}/${CHECKSUMS_FILE}) next to the file and run \`sha256sum -c ${CHECKSUMS_FILE} --ignore-missing\` (macOS: \`shasum -a 256 -c ${CHECKSUMS_FILE} --ignore-missing\`).`
    )
  }
  return md.join('\n') + '\n'
}

// ---- commands ---------------------------------------------------------------------------------

function check({ tag }) {
  const versions = readVersions()
  for (const [file, version] of Object.entries(versions)) {
    console.log(`${(version ?? '(missing)').padEnd(16)} ${file}`)
  }
  const distinct = new Set(Object.values(versions))
  if (distinct.has(undefined)) fail('a version file is missing its version; see the list above')
  if (distinct.size !== 1) {
    fail('version files disagree; run `npm run release -- <version>` to set them all at once')
  }
  const [version] = distinct
  parseSemver(version)
  if (tag && tag !== `v${version}`) {
    fail(`tag ${tag} does not match the version in the repository (expected v${version})`)
  }
  const prerelease = version.includes('-')
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\nprerelease=${prerelease}\n`)
  }
  console.log(`ok: all version files agree on ${version}${prerelease ? ' (pre-release)' : ''}`)
}

function bump(rawVersion, { dryRun, noGit }) {
  const version = rawVersion.replace(/^v/, '')
  parseSemver(version)
  const tag = `v${version}`
  const repo = detectRepo()
  const useGit = !noGit && !dryRun

  if (useGit) {
    if (git('status', '--porcelain', '--untracked-files=no') !== '') {
      fail(
        'the working tree has uncommitted changes; commit or stash them first (or pass --no-git)'
      )
    }
    if (git('tag', '--list', tag) !== '') fail(`tag ${tag} already exists`)
  }

  const setJsonVersion = (path, mutate) => {
    const json = readJson(path)
    mutate(json)
    return JSON.stringify(json, null, 2) + '\n'
  }
  const edits = [
    [FILES.rootPackage, () => setJsonVersion(FILES.rootPackage, (j) => (j.version = version))],
    [
      FILES.desktopPackage,
      () => setJsonVersion(FILES.desktopPackage, (j) => (j.version = version))
    ],
    [
      FILES.desktopLock,
      () =>
        setJsonVersion(FILES.desktopLock, (j) => {
          j.version = version
          if (j.packages?.['']) j.packages[''].version = version
        })
    ],
    [
      FILES.androidGradle,
      () => {
        const text = readText(FILES.androidGradle)
        if (!GRADLE_VERSION_RE.test(text))
          fail(`${rel(FILES.androidGradle)} has no 'val murmurVersion = "..."' line`)
        return text.replace(GRADLE_VERSION_RE, `val murmurVersion = "${version}"`)
      }
    ],
    [
      FILES.readme,
      () => {
        const text = readText(FILES.readme)
        if (!README_BLOCK_RE.test(text))
          fail(`${rel(FILES.readme)} has no <!-- downloads:start --> block`)
        return text.replace(README_BLOCK_RE, () => readmeBlock(repo, version))
      }
    ]
  ]

  const changed = []
  for (const [path, next] of edits) {
    const before = readText(path)
    const after = next()
    if (after === before) {
      console.log(`unchanged  ${rel(path)}`)
      continue
    }
    changed.push(path)
    console.log(`${dryRun ? 'would edit' : 'edited    '} ${rel(path)}`)
    if (!dryRun) writeFileSync(path, after)
  }

  if (dryRun) {
    console.log(`\ndry run: nothing written. Would commit "chore(release): ${tag}" and tag ${tag}.`)
    return
  }
  if (!useGit) {
    console.log(`\nversion set to ${version}; commit and tag ${tag} yourself (--no-git).`)
    return
  }

  git('add', '--', ...edits.map(([path]) => path))
  if (changed.length) git('commit', '-m', `chore(release): ${tag}`)
  else console.log('files already at this version; tagging the current commit')
  git('tag', '-a', tag, '-m', `Murmur ${tag}`)
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
  console.log(`
tagged ${tag}. To release, push the commit and the tag:

  git push origin ${branch} ${tag}

The Release workflow builds every platform and publishes
https://github.com/${repo}/releases/tag/${tag}`)
}

function notes(version, dir) {
  version = version.replace(/^v/, '')
  parseSemver(version)
  if (!dir || !existsSync(dir)) fail(`assets directory not found: ${dir}`)
  process.stdout.write(releaseNotes(detectRepo(), version, dir))
}

// ---- cli --------------------------------------------------------------------------------------

function main(argv) {
  const positional = []
  const flags = { dryRun: false, noGit: false, tag: undefined }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dry-run') flags.dryRun = true
    else if (arg === '--no-git') flags.noGit = true
    else if (arg === '--tag') flags.tag = argv[++i]
    else if (arg.startsWith('--tag=')) flags.tag = arg.slice('--tag='.length)
    else if (arg.startsWith('-')) fail(`unknown option ${arg}`)
    else positional.push(arg)
  }
  const [command, ...rest] = positional
  if (!command)
    fail(
      'usage: release.mjs <version> [--dry-run] [--no-git] | check [--tag vX.Y.Z] | notes <version> <dir>'
    )
  if (command === 'check') return check(flags)
  if (command === 'notes') {
    if (rest.length !== 2) fail('usage: release.mjs notes <version> <assets-dir>')
    return notes(rest[0], rest[1])
  }
  return bump(command, flags)
}

main(process.argv.slice(2))
