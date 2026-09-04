/**
 * Win32 input synthesis and foreground-window queries through koffi (N-API FFI, no compiler).
 * Everything here is lazily initialised and only ever touched on win32.
 */
import { createLogger } from '../logger'

const log = createLogger('win32')

const INPUT_KEYBOARD = 1
const KEYEVENTF_EXTENDEDKEY = 0x0001
const KEYEVENTF_KEYUP = 0x0002
const KEYEVENTF_UNICODE = 0x0004

export const VK = {
  BACK: 0x08,
  TAB: 0x09,
  RETURN: 0x0d,
  SHIFT: 0x10,
  CONTROL: 0x11,
  MENU: 0x12,
  ESCAPE: 0x1b,
  SPACE: 0x20,
  LWIN: 0x5b,
  RWIN: 0x5c,
  A: 0x41,
  C: 0x43,
  V: 0x56,
  LSHIFT: 0xa0,
  RSHIFT: 0xa1,
  LCONTROL: 0xa2,
  RCONTROL: 0xa3,
  LMENU: 0xa4,
  RMENU: 0xa5
} as const

interface Win32Api {
  SendInput: (count: number, inputs: unknown[], size: number) => number
  GetForegroundWindow: () => unknown
  GetWindowTextW: (hwnd: unknown, buf: Uint16Array, max: number) => number
  GetWindowThreadProcessId: (hwnd: unknown, pid: Uint32Array) => number
  OpenProcess: (access: number, inherit: boolean, pid: number) => unknown
  QueryFullProcessImageNameW: (
    h: unknown,
    flags: number,
    buf: Uint16Array,
    size: Uint32Array
  ) => number
  CloseHandle: (h: unknown) => number
  GetAsyncKeyState: (vk: number) => number
  inputSize: number
}

let api: Win32Api | null | undefined

function load(): Win32Api | null {
  if (api !== undefined) return api
  if (process.platform !== 'win32') return (api = null)
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi') as typeof import('koffi')
    const user32 = koffi.load('user32.dll')
    const kernel32 = koffi.load('kernel32.dll')

    const MOUSEINPUT = koffi.struct('MURMUR_MOUSEINPUT', {
      dx: 'long',
      dy: 'long',
      mouseData: 'uint32_t',
      dwFlags: 'uint32_t',
      time: 'uint32_t',
      dwExtraInfo: 'uintptr_t'
    })
    const KEYBDINPUT = koffi.struct('MURMUR_KEYBDINPUT', {
      wVk: 'uint16_t',
      wScan: 'uint16_t',
      dwFlags: 'uint32_t',
      time: 'uint32_t',
      dwExtraInfo: 'uintptr_t'
    })
    const HARDWAREINPUT = koffi.struct('MURMUR_HARDWAREINPUT', {
      uMsg: 'uint32_t',
      wParamL: 'uint16_t',
      wParamH: 'uint16_t'
    })
    const INPUT = koffi.struct('MURMUR_INPUT', {
      type: 'uint32_t',
      u: koffi.union({ mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT })
    })
    const HWND = koffi.pointer('MURMUR_HWND', koffi.opaque())
    const HANDLE = koffi.pointer('MURMUR_HANDLE', koffi.opaque())

    api = {
      SendInput: user32.func(
        'unsigned int __stdcall SendInput(unsigned int cInputs, MURMUR_INPUT *pInputs, int cbSize)'
      ),
      GetForegroundWindow: user32.func('MURMUR_HWND __stdcall GetForegroundWindow()'),
      GetWindowTextW: user32.func(
        'int __stdcall GetWindowTextW(MURMUR_HWND hWnd, _Out_ uint16_t *lpString, int nMaxCount)'
      ),
      GetWindowThreadProcessId: user32.func(
        'uint32_t __stdcall GetWindowThreadProcessId(MURMUR_HWND hWnd, _Out_ uint32_t *lpdwProcessId)'
      ),
      OpenProcess: kernel32.func(
        'MURMUR_HANDLE __stdcall OpenProcess(uint32_t dwDesiredAccess, bool bInheritHandle, uint32_t dwProcessId)'
      ),
      QueryFullProcessImageNameW: kernel32.func(
        'int __stdcall QueryFullProcessImageNameW(MURMUR_HANDLE hProcess, uint32_t dwFlags, _Out_ uint16_t *lpExeName, _Inout_ uint32_t *lpdwSize)'
      ),
      CloseHandle: kernel32.func('int __stdcall CloseHandle(MURMUR_HANDLE hObject)'),
      GetAsyncKeyState: user32.func('short __stdcall GetAsyncKeyState(int vKey)'),
      inputSize: koffi.sizeof(INPUT)
    }
    void HWND
    void HANDLE
    log.info(`koffi user32 loaded (sizeof INPUT=${api.inputSize})`)
    return api
  } catch (err) {
    log.error('koffi/user32 unavailable', err)
    return (api = null)
  }
}

export function win32Available(): boolean {
  return load() !== null
}

function keyEvent(vk: number, down: boolean, scan = 0, extraFlags = 0): unknown {
  return {
    type: INPUT_KEYBOARD,
    u: {
      ki: {
        wVk: vk,
        wScan: scan,
        dwFlags: (down ? 0 : KEYEVENTF_KEYUP) | extraFlags,
        time: 0,
        dwExtraInfo: 0
      }
    }
  }
}

function send(events: unknown[]): boolean {
  const a = load()
  if (!a || !events.length) return false
  const sent = a.SendInput(events.length, events, a.inputSize)
  if (sent !== events.length) log.warn(`SendInput sent ${sent}/${events.length} events`)
  return sent === events.length
}

/** Tap a key with modifiers, e.g. keyTap(VK.V, [VK.CONTROL]). */
export function keyTap(vk: number, modifiers: number[] = []): boolean {
  const ev: unknown[] = []
  for (const m of modifiers) ev.push(keyEvent(m, true))
  ev.push(keyEvent(vk, true))
  ev.push(keyEvent(vk, false))
  for (const m of [...modifiers].reverse()) ev.push(keyEvent(m, false))
  return send(ev)
}

/** Release modifiers the user may still be holding so a paste is not turned into another shortcut. */
export function releaseModifiers(): void {
  const a = load()
  if (!a) return
  const ev: unknown[] = []
  for (const vk of [
    VK.LCONTROL,
    VK.RCONTROL,
    VK.LSHIFT,
    VK.RSHIFT,
    VK.LMENU,
    VK.RMENU,
    VK.LWIN,
    VK.RWIN
  ]) {
    if (a.GetAsyncKeyState(vk) & 0x8000)
      ev.push(
        keyEvent(
          vk,
          false,
          0,
          vk === VK.RCONTROL || vk === VK.RMENU || vk === VK.LWIN || vk === VK.RWIN
            ? KEYEVENTF_EXTENDEDKEY
            : 0
        )
      )
  }
  if (ev.length) send(ev)
}

export function modifiersDown(): boolean {
  const a = load()
  if (!a) return false
  for (const vk of [VK.CONTROL, VK.SHIFT, VK.MENU, VK.LWIN, VK.RWIN]) {
    if (a.GetAsyncKeyState(vk) & 0x8000) return true
  }
  return false
}

/**
 * Type text into the focused control with KEYEVENTF_UNICODE, one down/up pair per UTF-16 code
 * unit (surrogate pairs simply become two pairs, Windows reassembles them). Newlines are sent as
 * VK_RETURN because most controls ignore a raw U+000A.
 */
export async function typeUnicode(
  text: string,
  chunkSize = 64,
  chunkDelayMs = 2
): Promise<boolean> {
  const a = load()
  if (!a) return false
  let events: unknown[] = []
  let ok = true
  const flush = async (): Promise<void> => {
    if (!events.length) return
    ok = send(events) && ok
    events = []
    if (chunkDelayMs > 0) await new Promise((r) => setTimeout(r, chunkDelayMs))
  }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\r') continue
    if (ch === '\n') {
      events.push(keyEvent(VK.RETURN, true), keyEvent(VK.RETURN, false))
    } else if (ch === '\t') {
      events.push(keyEvent(VK.TAB, true), keyEvent(VK.TAB, false))
    } else {
      const code = text.charCodeAt(i)
      events.push(
        keyEvent(0, true, code, KEYEVENTF_UNICODE),
        keyEvent(0, false, code, KEYEVENTF_UNICODE)
      )
    }
    if (events.length >= chunkSize * 2) await flush()
  }
  await flush()
  return ok
}

export function foregroundWindow(): { title: string; app: string; pid?: number } | null {
  const a = load()
  if (!a) return null
  try {
    const hwnd = a.GetForegroundWindow()
    if (!hwnd) return null
    const buf = new Uint16Array(512)
    const len = a.GetWindowTextW(hwnd, buf, buf.length)
    const title = String.fromCharCode(...buf.subarray(0, Math.max(0, len)))
    const pidOut = new Uint32Array(1)
    a.GetWindowThreadProcessId(hwnd, pidOut)
    const pid = pidOut[0]
    let app = ''
    if (pid) {
      const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
      const h = a.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
      if (h) {
        const nameBuf = new Uint16Array(1024)
        const size = new Uint32Array([nameBuf.length])
        if (a.QueryFullProcessImageNameW(h, 0, nameBuf, size)) {
          const full = String.fromCharCode(...nameBuf.subarray(0, size[0]))
          app = full.split(/[\\/]/).pop() ?? full
        }
        a.CloseHandle(h)
      }
    }
    return { title, app, pid }
  } catch (err) {
    log.warn('foregroundWindow failed', err)
    return null
  }
}
