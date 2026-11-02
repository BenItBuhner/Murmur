import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }))

import { isSafeExternalUrl } from '../src/main/windows/external'

describe('external links', () => {
  it('lets web and mail links out and nothing else', () => {
    expect(isSafeExternalUrl('https://murmur.example/account')).toBe(true)
    expect(isSafeExternalUrl('mailto:help@example.com')).toBe(true)
    expect(isSafeExternalUrl('file:///C:/Windows/System32/calc.exe')).toBe(false)
    expect(isSafeExternalUrl('ms-msdt:/id PCWDiagnostic')).toBe(false)
    expect(isSafeExternalUrl('smb://host/share')).toBe(false)
    expect(isSafeExternalUrl('not a url')).toBe(false)
  })
})
