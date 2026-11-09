/**
 * The text just before the caret in the focused field, on Windows, through UI Automation. It lets
 * a dictation continue what is already there: no capital when it goes on mid-sentence, no stray
 * space or period at the seam.
 *
 * UI Automation is COM, so it is read by one PowerShell process started on first use and kept
 * running; each dictation asks once at the key-down, while the user is talking, so it never adds
 * to the release. Password fields, fields without a text pattern, and anything slower than the
 * timeout give '' (the dictation is formatted as before).
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

/** Characters before the caret that are read; the formatter only needs the last sentence or so. */
const CHARS = 400

const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$TP = [System.Windows.Automation.TextPattern]::Pattern
$S = [System.Windows.Automation.Text.TextPatternRangeEndpoint]::Start
$E = [System.Windows.Automation.Text.TextPatternRangeEndpoint]::End
$C = [System.Windows.Automation.Text.TextUnit]::Character
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $out = ''
  try {
    $el = [System.Windows.Automation.AutomationElement]::FocusedElement
    $p = $null
    if ($el -and -not $el.Current.IsPassword -and $el.TryGetCurrentPattern($TP, [ref]$p)) {
      $sel = $p.GetSelection()
      if ($sel.Length -gt 0) {
        $r = $sel[0].Clone()
        $r.MoveEndpointByRange($E, $sel[0], $S)
        [void]$r.MoveEndpointByUnit($S, $C, -${CHARS})
        $out = $r.GetText(${CHARS})
      }
    }
  } catch { $out = '' }
  [Console]::Out.WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($out)))
}
`

let child: ChildProcessWithoutNullStreams | null = null
let waiting: Array<(s: string) => void> = []
let buffer = ''
let broken = false

function helper(): ChildProcessWithoutNullStreams | null {
  if (broken) return null
  if (child) return child
  try {
    const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64')
    const c = spawn(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true }
    )
    c.stdout.setEncoding('utf8')
    c.stdout.on('data', (d: string) => {
      buffer += d
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        const text = line ? Buffer.from(line, 'base64').toString('utf8') : ''
        waiting.shift()?.(text)
      }
    })
    const reset = (): void => {
      child = null
      buffer = ''
      for (const w of waiting) w('')
      waiting = []
    }
    c.on('exit', reset)
    c.on('error', () => {
      broken = true
      reset()
    })
    c.stdin.on('error', () => undefined)
    child = c
    return c
  } catch {
    broken = true
    return null
  }
}

/** Start the helper ahead of the first dictation, so its start-up (about a second) is not on it. */
export function warmPrecedingText(): void {
  if (process.platform === 'win32') helper()
}

/** Text before the caret in the focused field, or '' when it cannot be read within `timeoutMs`. */
export function precedingTextWin32(timeoutMs = 1500): Promise<string> {
  const c = process.platform === 'win32' ? helper() : null
  if (!c) return Promise.resolve('')
  return new Promise((resolve) => {
    let done = false
    const finish = (s: string): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(s)
    }
    // An answer that comes after the timeout still takes its place in the queue, so later
    // requests get their own answers.
    const timer = setTimeout(() => finish(''), timeoutMs)
    waiting.push(finish)
    c.stdin.write('q\n')
  })
}
