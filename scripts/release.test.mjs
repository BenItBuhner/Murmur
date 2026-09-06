import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  ASSETS,
  CHECKSUMS_FILE,
  INSTALL_HELPERS,
  downloadTable,
  isCloudRelease,
  knownReleaseFiles,
  latestDownloadBase,
  readmeBlock,
  releaseNotes
} from './release.mjs'

const ROOT = join(import.meta.dirname, '..')
const SCRIPT = join(import.meta.dirname, 'release.mjs')
const REPO = 'BenItBuhner/voxflow'

function run(args, opts = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_REPOSITORY: REPO },
    ...opts
  })
}

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'murmur-release-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('every asset has a unique versioned name and a unique stable alias', () => {
  const files = ASSETS.map((a) => a.file('0.1.0'))
  const aliases = ASSETS.map((a) => a.alias)
  assert.equal(new Set(files).size, files.length)
  assert.equal(new Set(aliases).size, aliases.length)
  for (const asset of ASSETS) {
    assert.ok(asset.alias, `${asset.group} ${asset.label} is missing alias`)
    assert.doesNotMatch(asset.alias, /0\.1\.0/)
    assert.notEqual(asset.file('0.1.0'), asset.file('0.2.0'))
  }
})

test('stable aliases never embed the version', () => {
  for (const asset of ASSETS) {
    assert.equal(asset.alias.includes('1.2.3'), false)
    assert.equal(asset.alias.includes('0.1.0'), false)
  }
})

test('latest download URLs do not pin a version', () => {
  const table = downloadTable(REPO, '0.1.0', { mode: 'latest' })
  assert.match(table, /\/releases\/latest\/download\/Murmur-setup\.exe/)
  assert.match(table, /\/releases\/latest\/download\/Murmur-android\.apk/)
  assert.doesNotMatch(table, /\/download\/v0\.1\.0\//)
  assert.doesNotMatch(table, /Murmur-0\.1\.0-setup\.exe/)
})

test('versioned download URLs pin the tag', () => {
  const table = downloadTable(REPO, '0.1.0')
  assert.match(table, /\/releases\/download\/v0\.1\.0\/Murmur-0\.1\.0-setup\.exe/)
  assert.doesNotMatch(table, /\/releases\/latest\/download\//)
})

test('README block uses latest aliases and the one-line installers', () => {
  const md = readmeBlock(REPO, '0.1.0')
  assert.match(md, /<!-- downloads:start v0\.1\.0 -->/)
  assert.match(md, /install\.sh/)
  assert.match(md, /install\.ps1/)
  assert.match(md, /\/releases\/latest\/download\/Murmur-setup\.exe/)
  assert.match(md, /\/releases\/latest\/download\/SHA256SUMS\.txt/)
  assert.equal(latestDownloadBase(REPO), `https://github.com/${REPO}/releases/latest/download`)
})

test('notes warn about missing versioned assets and list aliases when present', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, 'Murmur-0.1.0-setup.exe'), 'win')
    writeFileSync(join(dir, 'Murmur-setup.exe'), 'win')
    writeFileSync(join(dir, CHECKSUMS_FILE), 'deadbeef  Murmur-0.1.0-setup.exe\n')
    const md = releaseNotes(REPO, '0.1.0', dir)
    assert.match(md, /Murmur-0\.1\.0-setup\.exe/)
    assert.match(md, /Always latest/)
    assert.match(md, /\/releases\/latest\/download\/Murmur-setup\.exe/)
    assert.match(md, /Verify a download/)
  })
})

test('aliases copies stable names and install helpers', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, 'Murmur-0.1.0-setup.exe'), 'installer')
    writeFileSync(join(dir, 'Murmur-0.1.0-android.apk'), 'apk')
    const result = run(['aliases', '0.1.0', dir])
    assert.equal(result.status, 0, result.stderr)
    assert.equal(readFileSync(join(dir, 'Murmur-setup.exe'), 'utf8'), 'installer')
    assert.equal(readFileSync(join(dir, 'Murmur-android.apk'), 'utf8'), 'apk')
    for (const helper of INSTALL_HELPERS) {
      assert.equal(
        readFileSync(join(dir, helper.file), 'utf8'),
        readFileSync(helper.src, 'utf8')
      )
    }
  })
})

test('check agrees on the current version and rejects a mismatched tag', () => {
  const ok = run(['check'])
  assert.equal(ok.status, 0, ok.stderr + ok.stdout)
  const match = /ok: all version files agree on (\S+)/.exec(ok.stdout)
  assert.ok(match, ok.stdout)
  const version = match[1]

  const tagged = run(['check', '--tag', `v${version}`])
  assert.equal(tagged.status, 0, tagged.stderr + tagged.stdout)

  const bad = run(['check', '--tag', 'v9.9.9'])
  assert.notEqual(bad.status, 0)
  assert.match(bad.stderr, /does not match/)
})

test('release notes default to a local-only callout', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, 'Murmur-0.1.0-setup.exe'), 'win')
    const previous = process.env.MURMUR_CLOUD_RELEASE
    delete process.env.MURMUR_CLOUD_RELEASE
    try {
      assert.equal(isCloudRelease(), false)
      const md = releaseNotes(REPO, '0.1.0', dir)
      assert.match(md, /## Local-only build/)
      assert.match(md, /no production Convex or Clerk instance/)
    } finally {
      if (previous === undefined) delete process.env.MURMUR_CLOUD_RELEASE
      else process.env.MURMUR_CLOUD_RELEASE = previous
    }
  })
})

test('release notes omit the local-only callout when MURMUR_CLOUD_RELEASE=true', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, 'Murmur-0.1.0-setup.exe'), 'win')
    const previous = process.env.MURMUR_CLOUD_RELEASE
    process.env.MURMUR_CLOUD_RELEASE = 'true'
    try {
      assert.equal(isCloudRelease(), true)
      const md = releaseNotes(REPO, '0.1.0', dir)
      assert.doesNotMatch(md, /## Local-only build/)
    } finally {
      if (previous === undefined) delete process.env.MURMUR_CLOUD_RELEASE
      else process.env.MURMUR_CLOUD_RELEASE = previous
    }
  })
})

test('invalid versions are rejected', () => {
  const result = run(['notes', 'not-a-version', tmpdir()])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /not a valid version/)
})

test('knownReleaseFiles includes aliases and install helpers', () => {
  const known = knownReleaseFiles('0.1.0')
  assert.ok(known.has('Murmur-0.1.0-setup.exe'))
  assert.ok(known.has('Murmur-setup.exe'))
  assert.ok(known.has('install.sh'))
  assert.ok(known.has('install.ps1'))
  assert.ok(known.has(CHECKSUMS_FILE))
})

test('install.sh --print-url picks the Linux AppImage for this arch', () => {
  const result = spawnSync('bash', [join(ROOT, 'scripts/install.sh'), '--print-url'], {
    encoding: 'utf8',
    env: { ...process.env }
  })
  assert.equal(result.status, 0, result.stderr)
  const expected = process.arch === 'arm64' ? 'Murmur-arm64.AppImage' : 'Murmur-x86_64.AppImage'
  assert.match(result.stdout.trim(), new RegExp(`/${expected}$`))
})

test('aliases + notes with a full asset set produce no missing-file warnings', () => {
  withTempDir((dir) => {
    for (const asset of ASSETS) {
      writeFileSync(join(dir, asset.file('0.1.0')), asset.alias)
    }
    const aliased = run(['aliases', '0.1.0', dir])
    assert.equal(aliased.status, 0, aliased.stderr)
    const notes = run(['notes', '0.1.0', dir])
    assert.equal(notes.status, 0, notes.stderr)
    assert.doesNotMatch(notes.stderr, /expected release asset is missing/)
    assert.match(notes.stdout, /## Local-only build/)
    assert.match(notes.stdout, /## Downloads/)
    assert.match(notes.stdout, /Always latest/)
    assert.match(notes.stdout, /Install in one command/)
    assert.match(notes.stdout, /Murmur-0\.1\.0-setup\.exe/)
    assert.match(notes.stdout, /\/releases\/latest\/download\/Murmur-setup\.exe/)
    assert.match(notes.stdout, /install\.sh/)
  })
})

test('install.sh --help and --android --print-url', () => {
  const help = spawnSync('bash', [join(ROOT, 'scripts/install.sh'), '--help'], { encoding: 'utf8' })
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /Usage:/)

  const apk = spawnSync('bash', [join(ROOT, 'scripts/install.sh'), '--android', '--print-url'], {
    encoding: 'utf8'
  })
  assert.equal(apk.status, 0, apk.stderr)
  assert.match(apk.stdout.trim(), /\/Murmur-android\.apk$/)
})
