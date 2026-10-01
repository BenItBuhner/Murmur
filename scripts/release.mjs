#!/usr/bin/env node
// Release tooling for the Murmur monorepo. No dependencies; Node 22+.
//
//   node scripts/release.mjs <version> [--dry-run] [--no-git]
//     Bump every version file to <version>, regenerate the README download table, commit
//     "chore(release): v<version>" and create the annotated tag v<version>. Pushing that tag
//     triggers .github/workflows/release.yml, which builds every platform and publishes the
//     release, then moves the `latest` tag to the same commit (stable releases only).
//
//   node scripts/release.mjs check [--tag v<version>]
//     Verify that all version files agree (and match the given tag). Used by CI.
//
//   node scripts/release.mjs notes <version> <assets-dir>
//     Print release-notes markdown (what's new, download table, install notes) for the files in
//     <assets-dir>. Used by the release workflow to fill in the GitHub release body; the workflow
//     appends GitHub's generated changelog after it. What a version ships is written in WHATS_NEW
//     below, alongside the bump.
//
//   node scripts/release.mjs aliases <version> <assets-dir>
//     Copy each built file to its stable (unversioned) name and add install.sh / install.ps1 so
//     https://github.com/<repo>/releases/latest/download/<alias> keeps working after the next bump.
import { appendFileSync, copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
 * Every file a release ships, in display order. `file` must match the artifactName patterns in
 * apps/desktop/electron-builder.yml and the Android step of .github/workflows/release.yml.
 * `alias` is the stable name uploaded alongside it so /releases/latest/download/<alias> does not
 * break when the version changes.
 * Quirks worth knowing: NSIS emits a combined x64+arm64 installer in addition to the per-arch
 * ones when the pattern contains ${arch}, and .deb / AppImage use Debian arch names (amd64, x86_64).
 */
const ASSETS = [
  {
    group: 'Windows',
    label: 'Installer (x64 + arm64)',
    file: (v) => `Murmur-${v}-setup.exe`,
    alias: 'Murmur-setup.exe'
  },
  {
    group: 'Windows',
    label: 'Portable (x64)',
    file: (v) => `Murmur-${v}-portable.exe`,
    alias: 'Murmur-portable.exe'
  },
  {
    group: 'Windows x64 only',
    label: 'Installer',
    file: (v) => `Murmur-${v}-x64-setup.exe`,
    alias: 'Murmur-x64-setup.exe'
  },
  {
    group: 'Windows arm64 only',
    label: 'Installer',
    file: (v) => `Murmur-${v}-arm64-setup.exe`,
    alias: 'Murmur-arm64-setup.exe'
  },
  {
    group: 'Linux x64',
    label: 'AppImage',
    file: (v) => `Murmur-${v}-x86_64.AppImage`,
    alias: 'Murmur-x86_64.AppImage'
  },
  {
    group: 'Linux x64',
    label: '.deb',
    file: (v) => `murmur_${v}_amd64.deb`,
    alias: 'murmur_amd64.deb'
  },
  {
    group: 'Linux arm64',
    label: 'AppImage',
    file: (v) => `Murmur-${v}-arm64.AppImage`,
    alias: 'Murmur-arm64.AppImage'
  },
  {
    group: 'Linux arm64',
    label: '.deb',
    file: (v) => `murmur_${v}_arm64.deb`,
    alias: 'murmur_arm64.deb'
  },
  {
    group: 'macOS (Apple silicon)',
    label: '.dmg',
    file: (v) => `Murmur-${v}-arm64.dmg`,
    alias: 'Murmur-arm64.dmg'
  },
  {
    group: 'macOS (Apple silicon)',
    label: '.zip',
    file: (v) => `Murmur-${v}-arm64.zip`,
    alias: 'Murmur-arm64.zip'
  },
  {
    group: 'macOS (Intel)',
    label: '.dmg',
    file: (v) => `Murmur-${v}-x64.dmg`,
    alias: 'Murmur-x64.dmg'
  },
  {
    group: 'macOS (Intel)',
    label: '.zip',
    file: (v) => `Murmur-${v}-x64.zip`,
    alias: 'Murmur-x64.zip'
  },
  {
    group: 'Android',
    label: 'APK',
    file: (v) => `Murmur-${v}-android.apk`,
    alias: 'Murmur-android.apk'
  }
]
const CHECKSUMS_FILE = 'SHA256SUMS.txt'
const INSTALL_HELPERS = [
  { file: 'install.sh', src: resolve(ROOT, 'scripts/install.sh') },
  { file: 'install.ps1', src: resolve(ROOT, 'scripts/install.ps1') }
]
const EXTRA_RELEASE_FILES = [CHECKSUMS_FILE, ...INSTALL_HELPERS.map((h) => h.file)]

/**
 * What each release ships, as the GitHub release opens: one entry per version, a list of markdown
 * bullets, written with the version bump (`check` and `notes` warn when the version in the
 * repository has none). `notes` renders the entry under "What's new" above the download table.
 */
const WHATS_NEW = {
  '0.6.7': [
    "**A dictation you can feel, on Android.** Each moment has its own touch: a click when recording starts, a tick when it switches to transcribing, a light-then-firm pulse when the text lands, and a double click for a problem (a limit reached, a Murmur service unavailable, nothing heard). It happens whatever started the dictation: the floating button, the desktop-style pill's confirm and cancel, a hardware shortcut, Retry on the pill or in History. The **Haptics** switch on the Dictation button screen (on by default, beside Sounds) governs all of it, and the patterns follow the system's Touch feedback setting and intensity, like the keyboard's own taps; the pill preview on that screen plays them so the switch can be tried where it lives. A phone without a vibrator stays still.",
    '**The haptics that were already there never vibrated; fixed.** The light tap added with the sound cues in 0.5.x asked the vibrator without the `VIBRATE` permission, which Android refused quietly, so on a real phone those taps never happened. The permission is declared now.'
  ],
  '0.6.6': [
    '**A Murmur service that is down no longer hangs your dictation.** When the speech or formatting service behind Murmur\'s models is slow or down, a dictation used to wait up to 45 seconds and end in a bare error. The server now gives each request a budget sized from healthy response times (about 15 seconds for a short clip, a little more for a long one, 8 seconds per formatting round), retries once only when the request cannot have reached the model, and stops asking a provider that has just failed three times in a row for 15 seconds. The pill says "Murmur\'s speech service is unavailable right now" (or "formatting service"), your recording is kept for **Retry**, and nothing that failed is counted against your account. Your own provider is unaffected.'
  ],
  '0.6.5': [
    '**Android account sync, fixed.** Since 0.6.1 a phone could sit on "Offline" with hundreds of pending changes while dictation kept working. Two defects: a stats reply the app could not read blocked every pending change queued behind it, and a sign-in race at start-up could leave the phone offline until the app was restarted. The reply is read correctly now, a change the server has already taken is never retried, and the connection is no longer a one-shot: sync reconnects and re-authenticates on its own after network loss, restarts and updates, with a short, growing pause between attempts.',
    "**Sync now really retries, and says why if it can't.** The Sync row names the reason in plain words (no network, a token Clerk would not give, the server not answering) instead of a bare Offline, and a new **Connection details** diagnostic under Account › Diagnostics shows exactly what is happening (boot, Clerk, the last token fetch, the Convex socket, the queue), with Copy for a report you can share. A launch that died while connecting now holds the cloud back for a while and brings it up again by itself, rather than until the app is restarted.",
    '**No plan before your status arrives.** The account card on Android and desktop used to show Free and "Waiting for your account status…" while the status was still loading; it now says "Checking your account…" with no badge until the status is here, then Unlimited, the private-testing notice or your plan as before.'
  ],
  '0.6.4': [
    '**Android updates no longer install in the background.** Murmur still checks for a new version and, with **Download updates automatically** on (the setting that was called **Install automatically**; your choice carries over), downloads and verifies it in the background. Then it posts one quiet notification per version and waits: the install starts only when you tap **Install** on the Updates screen, so Play Protect no longer pops up on its own in the middle of something. Inside the app the drawer dot and the Home card say a version is ready.',
    "**A cleaner layout on every platform.** Android's drawer is down to Home, History, Dictionary and snippets, Style, and one Settings area, with a single account entry; the Listening row is gone. On desktop the sidebar follows the same structure: Dictionary and snippets are one page, and Speech model, Shortcuts, Microphone, Dictation button and Appearance are pages of their own. Nothing moved out of reach; it moved to where the other platform keeps it.",
    '**Dialogs and the drawer dim properly in light mode.** The scrim behind a dialog and behind the open drawer darkened in dark mode but faded the screen to white in light mode; it darkens in both now, on both apps.',
    '**A predictive back animation that follows your finger.** On Android, pulling back from a screen slides it aside with your finger instead of shrinking it, and letting go finishes the motion; the screen below is previewed as you pull.'
  ],
  '0.6.3': [
    '**Fast skips AI formatting.** A Fast dictation now takes the quick path all the way: the speech model, then the instant Light cleanup (capitalisation, punctuation, fillers, spoken commands, dictionary, snippets) straight into the field, with no formatting-model request on either the managed or your own model. Normal is unchanged. The choice follows the speed you asked for, so it holds even while the server falls back to the normal speech model. History marks the entry **fast** and says "model skipped: fast speed".',
    "**Per-app rules can set a Speed.** A rule on the Style page (desktop) or Style screen (Android) can pick Normal or Fast for one app alongside its tone and formatting, with the same precedence: the first matching rule wins, Default inherits the device's Speed setting. Rule speeds sync between devices with the rest of the rule; an older app that re-saves a rule leaves the speed inheriting.",
    "**Two desktop fixes in the same path.** A per-app rule's formatting-mode override never applied on desktop (the engine read the field under a different name than the apps store it); it does now. And **Add rule** used to reset the whole Style section (tone, instructions, mode, the use of the dictionary) because a rule with an empty match failed validation while you were still typing it; the rule stays and the section keeps its settings."
  ],
  '0.6.2': [
    "**A Speed setting for Murmur's speech model.** Models → Speech to text on desktop and the Speech model screen on Android gain a Speed row, shown when the speech source is Murmur's models: **Normal** (today's model, the default) or **Fast**, a quicker model the server may offer. Fast is a device setting, so a phone and a laptop can differ. Your own provider has no Speed row; nothing changes there.",
    '**Fast falls back to Normal, and says so, until the fast model is available.** While the server has no fast model yet, or its provider does not know the model, a Fast dictation runs on Normal and the Speed row carries a note ("Fast isn\'t available on this server yet; dictations use Normal until it is"). History shows which ran: a `fast` or `fast unavailable` tag on the row, "Fast isn\'t available yet, used Normal" in the detail, and the model line ends in Normal or Fast. Every other error from the server is reported as before, never hidden behind the fallback.'
  ],
  '0.6.1': [
    "**Android 0.6.0 crashed at launch; fixed.** The sign-in screen that 0.6.0 opens with crashed the moment it appeared (Clerk's form was given no height to fit in), and once Clerk had cached its state the app died on every launch after that. The form now has a finite height, so tall phones fit everything and short ones scroll.",
    '**A server problem can no longer stop the app from starting.** Clerk, the Convex client and the sync engine each come up behind a guard: whatever fails, Murmur runs in local mode, with your own provider, settings and history all working, and the Account screen says "Couldn\'t connect to Murmur\'s server" with the cause and a Try again. The sign-in screen offers Continue without an account after 20 seconds or on a Clerk error, and a launch that dies while the cloud is coming up makes the next launch skip the cloud.',
    "**Updates verify against GitHub's own file checksums and retry.** A phone on 0.5.11 downloaded 0.6.0 and then said the release ships no checksum file; it does, and the message was a failed download of it. Both apps now check the file against the checksum GitHub records for every release asset (no second download), fall back to `SHA256SUMS.txt` with retries, and tell a checksum that could not be fetched (retried after an hour) apart from one that does not exist (manual install only). Install 0.6.1 by hand once; from then on updates install on their own."
  ],
  '0.6.0': [
    "**Murmur connects to its own server.** This is the first release built against Murmur's production instance. Sign in from Account (an email code today; Google sign-in is on its way) and your dictionary, snippets, style, per-app rules and, if you switch it on, dictation history stay in step across your devices, and the apps can dictate through Murmur's own speech and formatting models. The server is in private testing: those models answer invited accounts only, and any other account that signs in is told so on Home and Account while its dictionary, snippets, style and stats keep syncing. Nothing needs an account: your own provider or a local model works as before, on every platform, and nothing is billed.",
    '**The website moved to murmur.techlitnow.com.** The landing, download and account pages, the release manifest (`/api/releases/latest`) and the `/download/{windows,linux,android}` redirects now live at [murmur.techlitnow.com](https://murmur.techlitnow.com).'
  ],
  '0.5.11': [
    '**The floating button appears the moment you tap into a text field.** It goes to the spot where your keyboard will stop as soon as a field is focused or tapped, about 80 ms before Android reports the keyboard, instead of waiting for that report. If a field brings no keyboard up (a custom keypad, say), the button disappears again within a third of a second and Murmur remembers not to do that for that field. Nothing changes in keyboard mode or with a hardware keyboard attached.',
    "**Less work between the tap and the button.** The button's windows are created once and kept ready in the background rather than rebuilt on every opening, and the reads of other apps' views that used to run on the path that shows the button (the keyboard's own window while it is busy coming up, the focused field) have moved to a thread of their own, so a slow app never delays it. The keyboard timing log records each of these steps."
  ],
  '0.5.10': [
    "**No half-second wait for keyboards Murmur could not place.** Keyboards whose resting position could not be read from their window (a keyboard that hides its views from accessibility services, one in a full-screen window, or one resting low in its window) made the floating button wait about half a second on every opening. Where such a keyboard rests is now remembered, per keyboard and screen size, and kept across restarts, so the button appears at that spot from the keyboard's first report; only the very first opening still waits to learn it. Keyboards that were already placed from their window are unchanged.",
    '**Copy keyboard timing log.** Setup → Permissions gains a Diagnostics group with a **Copy keyboard timing log** button: it copies a timestamped trace of the last few keyboard openings and closings (what Android reported and when, what the button did with it) so you can share it when the button is late or in the wrong place. The log stays on the device, is never sent anywhere, and never contains typed text.'
  ],
  '0.5.9': [
    '**The floating button appears the instant the keyboard opens.** It is fully there from its first frame, already at its final spot, even while the keyboard is still sliding in, instead of fading in after a delay (a regression in 0.5.7, where a 160 ms fade started only once the keyboard had been reported at rest). The very first time a new keyboard opens, the button can still wait until that keyboard has settled, once, to learn where it rests; from the next opening on it is instant.'
  ],
  '0.5.8': [
    '**The keyboard-mode idle bar lets taps through.** With a hardware keyboard attached, the thin idle bar on Android no longer catches taps meant for the app icons beneath it: taps pass through, and the shortcuts start dictation, as on desktop. A new setting under Keyboard → Overlay, **Tap the idle bar to dictate** (off by default), makes the bar itself take a tap again, with no invisible padding around it. Without a hardware keyboard the bar still takes a tap, since there is no shortcut to start dictation with.',
    "**Phones stay in touch mode when turned.** Keyboard mode used to switch on when a phone was rotated to landscape, because the rule looked at the width in the current orientation. It now looks at the screen's shorter side (Android's own tablet line), so a phone never enters keyboard mode by rotating, and a tablet, or an unfolded foldable, uses keyboard mode in either orientation. A keyboard or a DeX session still switches it live."
  ],
  '0.5.7': [
    "**The floating button leaves as the keyboard starts to close.** Tapping the keyboard's close chevron (or the system Back button, or a hardware Back key) takes the Android button away the moment your finger lifts, before the keys start sliding, instead of leaving it over the app until the keyboard has gone. A close by the back gesture, Done or the app itself gives no earlier signal, so there the button still hides when the keyboard is fully gone, in one go and without moving.",
    '**It fades in where the keyboard rests.** When the keyboard opens, the button fades in at its resting spot instead of popping in partway up the slide and easing into place, and it no longer dips and snaps back when an app scrolls the keyboard slightly. The very first open of a keyboard after installing waits about half a second, once, to learn where that keyboard rests.'
  ],
  '0.5.6': [
    "**The floating button stays where your finger is.** Picking the Android button up and dropping it on another spot no longer flashes it at the top of the screen or flies it in from below: the button's canvas covers the screen and is placed once for as long as the button is shown, so every move is a redraw inside it rather than a window move Android animates from the old place.",
    "**It follows the keyboard without the old ease and delay.** The button appears at its spot the moment Android first reports the keyboard, measured from where the keyboard will rest, and is gone in the frame the keyboard's window goes; every reported change is drawn in the next frame, with no easing, no restarted slide and no 50 ms hold. A keyboard lifted above its resting edge is on its way to Recents and counts as gone instead of pulling the button up the screen.",
    "**Dictation history sync on Android (opt-in).** In cloud builds connected to a Murmur instance, Account gains the desktop's \"Sync dictation history\" switch, off by default and shared across your devices. On, the text of successful dictations (never audio or timings) is kept in step through the account; entries from other devices appear in History tagged with their device, can be read, copied and deleted, and Clear all clears the account's copy too. Off again, the other devices' entries leave this phone and the account keeps them."
  ],
  '0.5.5': [
    "**Android with a keyboard behaves like the desktop app.** With a physical keyboard, in DeX or on a tablet-width screen, Murmur takes the desktop shortcuts: hold Ctrl + Meta to talk and release to insert, Ctrl + Meta + Space for hands-free, Shift + Meta to edit the selected text by voice (command mode). A Keyboard screen holds a shortcut recorder and the same options as the desktop Shortcuts page. The floating button becomes the desktop-style pill, parked at the overlay position, and switches back and forth live as a keyboard attaches and detaches; phones keep the button and its spots. The desktop sounds and haptics arrive behind switches on the Dictation button screen, and screens take tablet layouts (a standing rail, capped content). Keyboard shortcuts run through the accessibility service, so after updating switch Murmur's accessibility service off and on once.",
    '**Settings that match on every platform.** The transcription and formatting timeouts are visible on Android with the desktop\'s defaults and bounds (the formatting timeout moves from 15 s to 8 s once, as on desktop). The session length limit is now optional and off by default on Android; it used to cut every dictation at 5 minutes. Android gains the provider presets, snippets, per-app rules, the switch for biasing the speech model with your dictionary, and the "show latency" setting. On desktop, a transcription timeout above 120 s no longer wipes the speech provider settings; the number inputs clamp to their bounds.',
    "**The speech model's text is never rewritten.** 0.5.4 restored the t a speech model can cut from a negative contraction (\"don' recall\"); that rule is gone, since Murmur should not patch a model's output with heuristics of its own. In the default formatting mode a cut contraction still keeps the dictation out of the clean skip, so the formatting model reads the whole sentence and fixes it; with formatting light or off the transcript goes in as the speech model returned it."
  ],
  '0.5.4': [
    '**Contractions arrive whole.** A speech model asked for a timestamped transcript can drop the t of a negative contraction in front of a consonant ("I don\' recall", "didn\' call", "doesn\' matter"), and short clean dictations went into the field exactly like that. Murmur now restores the missing letter first, in every app and with formatting on, light or off; the apostrophe keeps its shape, and quoted words and dropped-g dialect ("nothin\'") are left alone.',
    "**OpenAI speech preset moves to `gpt-transcribe`.** OpenAI removes `whisper-1`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe` and `gpt-4o-transcribe-diarize` from its API on 26 February 2027; the preset now offers `gpt-transcribe`, and an install that still names one of those models on OpenAI's own host is moved to it once, on both apps. The same model ids on Groq, a proxy or a local server are untouched.",
    "**One-line installers name the repository.** `install.sh` and `install.ps1` download from the repository's current name, `BenItBuhner/Murmur`, instead of relying on GitHub redirecting the old one."
  ],
  '0.5.3': [
    '**Enter arrives on its own.** Saying "press enter" or "send it" at the end of a dictation now sends Enter as a separate keystroke a moment after the text, on every insertion path. Before, both landed in the same instant, and programs over SSH read them as one paste: Claude Code dropped the whole dictation and kept only the Enter, Gemini CLI and Codex CLI took the Enter for a newline inside the paste. Now the text lands, then the command runs.',
    '**Terminals keep every character.** When Murmur types into a terminal key by key (Termux, ConnectBot and other apps that take raw keystrokes), a curly quote, a dash, an ellipsis or an accented letter used to change how the whole dictation was sent, and some letters went out as Alt chords the terminal read as Escape sequences. Each character now goes in as a plain key when a plain key types it and is committed as text otherwise, so contractions, quotes, dashes and accents arrive as spoken.',
    '**Dictionary corrections inside possessives.** On Android a dictionary entry is now corrected inside a possessive ("bennet\'s phone" becomes "Bennett\'s phone"), as it already was on desktop and in the gateway. On both platforms a plural possessive keeps its apostrophe through the correction ("the bennets\' house" becomes "the Bennetts\' house", not "the Bennetts house"), and a quoted name keeps its closing quote.',
    '**Short, clean dictations finish faster.** A dictation of up to twelve words that the speech model already punctuated, with no filler, stutter, correction, number, spoken command or non-English word in it, is finished by the rules alone and skips the formatting model; History marks it clean. Everything the model would have changed still goes to the model.'
  ],
  '0.5.2': [
    "**Dictation lands in terminals on Android.** Terminal apps such as Termius, Termux and ConnectBot take text only through the keyboard and expose no editable field, so a dictation into them always ended in the failed-to-insert notice. On Android 13 and newer, Murmur can now type through the system's input-method path instead: turn on **Permissions → Experimental → Keyboard support** (off by default). After updating, switch Murmur's accessibility service off and on once so the new keyboard flag takes effect; the notice tells you if it is missing. Enter still runs the command.",
    '**A failure notice that names the step.** When text does not land, the notice says which step failed (no field, the editor rejected the text, no keyboard connection, keyboard support off, or an Android older than 13) instead of the bare failure; Copy and Retry keep the recording as before.',
    '**Button shadow has one home on Android.** The switch moved from Appearance to the Dictation button screen, in a Look group between Shape and Spots, where the button itself is set; the preview above it goes flat or lifts as you flip it. Appearance points there in one line. Desktop keeps the switch under General → Appearance next to the other pill rows.'
  ],
  '0.5.1': [
    "**Default spots that fit the phone.** On Android the dictation button's two default spots are the ones tuned on a Galaxy S26 Ultra (spot 1 in the bottom-left corner, spot 2 centred 25 dp above the keyboard); an S26 Ultra gets those exact numbers and every other phone derives the same two spots from its own display geometry. Spots you edited stay as they are; Reset returns to the device's default.",
    '**Button shadow, a setting.** Settings → Appearance on Android and General → Appearance on desktop gain a Button shadow toggle (on by default). Off, the dictation pill is drawn flat in every state, and on Android the edit panel and its chips with it: same shape, colours and contents, nothing lifted.',
    "**A fully opaque pill.** The pill body, the status tints, the edit panel and its chips were 90 to 96 % opaque, so the keyboard and a whisper of the pill's own shadow showed through; on desktop the idle bar was 60 %. Every one of those surfaces is now solid, with the shadow on or off, on both apps.",
    "**Website download links follow the latest release.** `/download/windows`, `/download/linux` and `/download/android` redirect to GitHub's latest-release aliases (`Murmur-setup.exe`, `Murmur-x86_64.AppImage`, `Murmur-android.apk`), which GitHub resolves to the current release on every request, so the links are right the moment a release is published instead of waiting on the site's cache."
  ],
  '0.5.0': [
    '**The text engine, rebuilt.** The formatting model now reads the raw transcript together with where the text is going, what is already before the cursor, your dictionary and your instructions, and a verifier holds its answer to checks that need no understanding of the text: not empty or chatty, most of your words kept, verbatim phrases intact, and exactly the same numbers in the same order ("one million two hundred thousand dollars" comes back as $1,200,000, never as "one million $200,000"). One strict retry, then the rule-based cleanup, and History says why. One implementation runs on the desktop, on Android and in the gateway.',
    '**Design pass.** Both apps draw their structure with surfaces and space instead of lines: one radius scale on the 4px grid, three elevation levels, tonal fields and buttons, corners that stay concentric inside cards, and the serif wordmark instead of a placeholder icon. Nothing about how they behave changed.',
    '**Plans and limits, explained in the apps.** Account shows where the account stands (Pro trial with the days left, Free, Pro), one meter per allowance with when it resets, and Upgrade or Manage plan. A refused dictation is explained on the pill (which limit, the allowance, when it comes back) with Retry and Use my own model, and the recording is kept. When the formatting model pauses for fair use the text is still inserted, tidied by rules, and the pill says so.',
    "**Retired presets moved.** Groq retired `llama-3.1-8b-instant`, `llama-3.3-70b-versatile` and `distil-whisper-large-v3-en`, and OpenAI is shutting `gpt-4.1-nano` down: the presets now offer `openai/gpt-oss-20b`, `openai/gpt-oss-120b` and `gpt-5.6-luna`, and an install that still names a retired model on the provider's own host is moved to its replacement once, on both apps.",
    '**Website.** Landing, pricing, download and account pages, privacy and terms, the release manifest (`/api/releases/latest`) and `/download/{windows,linux,android}` redirects that always point at the current release.',
    '**Accounts, trial and billing backbone.** Every account starts a 14-day Pro trial with no card, then keeps a free tier of 500 words a week; Pro is $7.50 a month or $72 a year, unlimited within fair use; Stripe Checkout, the Customer Portal and its webhook; every limit enforced in the gateway with a structured refusal the apps can read. This is on for cloud builds connected to a Murmur instance; a local-only build keeps everything on the device.',
    "**Found end to end, fixed.** Account and Home at the Pro hard cap said the formatting model was paused while every clip was refused; they now say transcription is paused until the reset, and the free tier's Home line says when its monthly minutes are spent. A refused or failed dictation is logged with its reason. Desktop: the Models connection test stays inside its card and Style has one Model label. Android: Manage account and the privacy and terms links on Account.",
    '**Android settings no longer lose a change to another.** Two changes landing at once (a toggle flipped while a synced dictionary edit or a finished dictation was being saved) could let the slower one write over the faster one: a toggle flipping back, a synced dictionary edit dropping, or the stats of a dictation that finished during another change going missing. Settings updates are now atomic.',
    "**Since 0.4.0 on the way here.** Retry a failed dictation from the pill or from History, with recordings kept (on by default); the Android drawer and dashboard Home with history and stats, and motion on both apps; the Android pill follows light and dark mode; cloud builds use the instance's models by default with your own provider as the alternative; dictation no longer stops itself after 300 seconds."
  ]
}

/** The "What's new" bullets for `version`, or null when none were written. */
function whatsNew(version) {
  return WHATS_NEW[version] ?? null
}

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

/** True only when the release workflow is explicitly allowed to bake/deploy a cloud instance. */
function isCloudRelease() {
  return process.env.MURMUR_CLOUD_RELEASE === 'true'
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

function latestDownloadBase(repo) {
  return `https://github.com/${repo}/releases/latest/download`
}

function knownReleaseFiles(version) {
  return new Set([
    ...ASSETS.map((a) => a.file(version)),
    ...ASSETS.map((a) => a.alias),
    ...EXTRA_RELEASE_FILES
  ])
}

function installOneLiners(repo) {
  const latest = latestDownloadBase(repo)
  return [
    '```bash',
    `# Linux / macOS`,
    `curl -fsSL ${latest}/install.sh | bash`,
    '',
    `# Windows (PowerShell)`,
    `irm ${latest}/install.ps1 | iex`,
    '```'
  ]
}

// ---- markdown ---------------------------------------------------------------------------------

function downloadBase(repo, version) {
  return `https://github.com/${repo}/releases/download/v${version}`
}

/**
 * Markdown table of download links.
 * `mode: 'versioned'` uses /releases/download/vX/Murmur-X-...
 * `mode: 'latest'` uses /releases/latest/download/<alias> so README links survive the next bump.
 */
function downloadTable(repo, version, { present = null, mode = 'versioned' } = {}) {
  const base = mode === 'latest' ? latestDownloadBase(repo) : downloadBase(repo, version)
  const rows = new Map()
  for (const asset of ASSETS) {
    const file = mode === 'latest' ? asset.alias : asset.file(version)
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
  const latest = latestDownloadBase(repo)
  return [
    `<!-- downloads:start ${tag} -->`,
    '<!-- Generated by `npm run release`; edit scripts/release.mjs instead of this block. -->',
    `**Latest release: [${tag}](${releases}/tag/${tag})** · [All releases](${releases}) · [Checksums](${latest}/${CHECKSUMS_FILE})`,
    '',
    'The links below always resolve to the current stable release (`/releases/latest`). Versioned',
    `filenames for ${tag} are on the [release page](${releases}/tag/${tag}).`,
    '',
    ...installOneLiners(repo),
    '',
    downloadTable(repo, version, { mode: 'latest' }),
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
  const known = knownReleaseFiles(version)
  const other = [...present].filter((f) => !known.has(f)).sort()
  const groups = new Set(ASSETS.filter((a) => present.has(a.file(version))).map((a) => a.group))
  const signed = {
    windows: process.env.MURMUR_WIN_SIGNED === 'true',
    mac: process.env.MURMUR_MAC_SIGNED === 'true',
    android: process.env.MURMUR_ANDROID_RELEASE_KEY === 'true'
  }
  const base = downloadBase(repo, version)
  const latest = latestDownloadBase(repo)
  const aliasPresent = new Set(ASSETS.filter((a) => present.has(a.alias)).map((a) => a.alias))

  const md = [
    'Hold a key (or tap a pill), speak, and clean text lands wherever your cursor is.',
    ''
  ]
  const news = whatsNew(version)
  if (news) md.push("## What's new", '', ...news.map((n) => `- ${n}`), '')
  else warn(`no What's new entry for ${version} in scripts/release.mjs (WHATS_NEW)`)
  if (!isCloudRelease()) {
    md.push(
      '## Local-only build',
      '',
      'This release is **local-only**. There is no production Convex or Clerk instance yet, so',
      'accounts and cloud sync are disabled: dictionary, snippets, and settings stay on the device.',
      'Nothing is uploaded. A future release will turn accounts on once that instance exists.',
      ''
    )
  }
  md.push('## Downloads', '', downloadTable(repo, version, { present }))
  if (aliasPresent.size) {
    md.push(
      '',
      '### Always latest (stable filenames)',
      '',
      `These names stay the same on every stable release. ${latest}/<file> follows GitHub's latest release.`,
      '',
      downloadTable(repo, version, { present: aliasPresent, mode: 'latest' })
    )
  }
  if (INSTALL_HELPERS.some((h) => present.has(h.file))) {
    md.push('', '## Install in one command', '', ...installOneLiners(repo))
  }
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
  if (!whatsNew(version)) {
    warn(
      `no What's new entry for ${version} in scripts/release.mjs (WHATS_NEW); the release will open with the download table`
    )
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

The Release workflow builds every platform, publishes
https://github.com/${repo}/releases/tag/${tag},
and (for stable releases) moves the \`latest\` tag to the same commit.`)
}

function notes(version, dir) {
  version = version.replace(/^v/, '')
  parseSemver(version)
  if (!dir || !existsSync(dir)) fail(`assets directory not found: ${dir}`)
  process.stdout.write(releaseNotes(detectRepo(), version, dir))
}

/** Copy versioned artifacts to stable names and attach the one-line install helpers. */
function aliases(version, dir) {
  version = version.replace(/^v/, '')
  parseSemver(version)
  if (!dir || !existsSync(dir)) fail(`assets directory not found: ${dir}`)
  const present = new Set(readdirSync(dir))
  let copied = 0
  for (const asset of ASSETS) {
    const srcName = asset.file(version)
    if (!present.has(srcName)) continue
    if (srcName === asset.alias) continue
    copyFileSync(resolve(dir, srcName), resolve(dir, asset.alias))
    console.error(`aliased ${srcName} -> ${asset.alias}`)
    copied += 1
  }
  for (const helper of INSTALL_HELPERS) {
    if (!existsSync(helper.src)) {
      warn(`install helper missing: ${rel(helper.src)}`)
      continue
    }
    copyFileSync(helper.src, resolve(dir, helper.file))
    console.error(`copied   ${rel(helper.src)} -> ${helper.file}`)
    copied += 1
  }
  if (!copied) warn('no aliases or install helpers were written')
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
      'usage: release.mjs <version> [--dry-run] [--no-git] | check [--tag vX.Y.Z] | notes <version> <dir> | aliases <version> <dir>'
    )
  if (command === 'check') return check(flags)
  if (command === 'notes') {
    if (rest.length !== 2) fail('usage: release.mjs notes <version> <assets-dir>')
    return notes(rest[0], rest[1])
  }
  if (command === 'aliases') {
    if (rest.length !== 2) fail('usage: release.mjs aliases <version> <assets-dir>')
    return aliases(rest[0], rest[1])
  }
  return bump(command, flags)
}

const invokedDirectly =
  Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (invokedDirectly) main(process.argv.slice(2))

export {
  ASSETS,
  CHECKSUMS_FILE,
  EXTRA_RELEASE_FILES,
  INSTALL_HELPERS,
  WHATS_NEW,
  downloadTable,
  isCloudRelease,
  knownReleaseFiles,
  latestDownloadBase,
  parseSemver,
  readmeBlock,
  releaseNotes,
  whatsNew
}
