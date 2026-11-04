# Phone as microphone

A signed-in phone can be the microphone for Murmur on a desktop signed in to the same account.
You walk around talking to the phone; the text lands at the cursor on the desktop, exactly as if
you had dictated into the desktop's own microphone. It is meant for long dictations (30 minutes
and more) and for desktops whose microphone is poor or missing.

This document is the plan written before the code, kept up to date as the design record.

## Requirements

1. **Audio never goes through Convex**, and is never stored anywhere but where it already is (the
   desktop's own History recording). Murmur once streamed and stored audio in Convex and hit the
   free plan's limits; the fixes since (the inference Worker, `bootstrap.get` instead of live
   subscriptions, `deviceLiveness` and `historyMeta` kept off subscribed rows, throttled
   heartbeats) are the rules this feature follows.
2. **Server cost must not grow with audio minutes.** A 3-hour dictation must cost the backend the
   same as a 3-second one.
3. **Long sessions**: an hour of talking without a server timeout, a token expiry or a buffer
   limit ending it, and a brief Wi-Fi drop must not lose what was said.
4. **Discreet**: off by default, one switch on the desktop's Microphone page; nothing changes for
   anyone who does not turn it on.
5. **Ports to Ephemeris**: the desktop and backend pieces live in files Ephemeris takes from Murmur
   unchanged (`apps/desktop`, `packages/backend`), with the wiring in its own files kept to a few
   lines.

## Design

```
 phone                                  Convex (signaling only)                 desktop
 -----                                  -----------------------                 -------
 micLink.receivers  ───── query ──────▶ micReceivers (1 row per desktop
                                        with the switch on)
 RTCPeerConnection.createOffer
 (ICE gathered, one SDP)
 micLink.offer ────────── mutation ───▶ micSignals row ── inbox subscription ─▶ RTCPeerConnection
                                                                                 .createAnswer
 inbox subscription ◀──── answer row ◀─ micSignals row ◀──── mutation ────────── micLink.answer
 (closed after the answer)
 micLink.take (deletes it)

 ═══════════════ WebRTC, peer to peer, DTLS-SRTP encrypted ═══════════════════════════════
 audio track (Opus, mono, FEC) ─────────────────────────────────────────────▶ MicCapture
 data channel "control": start / stop / cancel ─────────────────────────────▶ DictationController
                         state / level / result ◀──────────────────────────── 
```

### Media: WebRTC, peer to peer

- The phone sends one audio track; Opus mono, in-band FEC on, DTX off, ~32 kbit/s. WebRTC brings
  the jitter buffer, packet-loss concealment, congestion control and encryption (DTLS-SRTP, keyed
  by fingerprints exchanged over the authenticated signaling channel, so nobody in between,
  Convex included, can listen).
- On the desktop the remote track is handed to the existing `MicCapture` in the overlay renderer
  instead of `getUserMedia`'s stream. Everything after that (16 kHz resampling in the
  AudioContext, the pre-roll buffer, levels, VAD, streaming long dictations in pieces, History
  recordings, retry) is the code every dictation already runs. Nothing new handles PCM.
- ICE: host candidates connect phone and desktop directly on the same network (the common case:
  the phone is on the home or office Wi-Fi). Public STUN servers (Google, Cloudflare) cover
  phone-on-cellular through most NATs. A TURN relay can be configured
  (`MURMUR_MIC_ICE_SERVERS`, see below) for networks where nothing else works; it is a relay the
  operator chooses, never Convex.

### Signaling: Convex, a handful of calls per link

A *link* is a phone connected to a desktop; it lasts as long as the phone keeps it open (hours)
and carries any number of dictations. Per link:

| Call | Who | Function calls |
| --- | --- | --- |
| `micLink.receivers` (one-shot query) | phone, when the screen opens | 1 |
| `micLink.offer` (mutation) | phone | 1 |
| inbox re-run on the new offer | desktop subscription | 1 |
| `micLink.answer` (mutation) | desktop | 1 |
| inbox re-run on the answer, and on the offer's removal | both subscriptions | 2 |
| `micLink.take` (mutation, deletes the answer) | phone | 1 |

About seven function calls and two short-lived rows (an SDP is 2–6 KB) per link, whatever its
length. Nothing is written per dictation, per second of audio or per heartbeat.

- **No trickle ICE.** Each side waits for candidate gathering to finish (capped at 3 s) and sends
  one complete SDP, so a link is exactly one offer and one answer, not dozens of candidate rows.
- **Idle cost is zero.** A desktop with the switch on holds one subscription to
  `micLink.inbox({deviceId})`, which reads only rows addressed to that device. Convex re-runs a
  query only when something it read changes, so an idle desktop costs no function calls at all;
  it re-runs when an offer for it arrives. The phone holds the same subscription only between its
  offer and the answer, then drops it.
- **Nothing piles up.** An answer is deleted when the phone takes it, an offer when the desktop
  answers it. Each `offer` deletes that receiver's expired rows (older than 2 minutes) and keeps
  at most 4 pending; rows are capped at 16 KB of SDP. There is no cron.
- **`micReceivers`** holds one row per desktop that has the switch on (deviceId, name, platform,
  last registration time). It is written when the switch or the device name changes, and at most
  once a day otherwise; never on a heartbeat. It is its own table so that `devices.list` and
  `bootstrap.get` are not re-run by it, and the phone lists only desktops that can answer.
- **Desktops that went away drop off the list without a write.** A desktop unregisters when the
  switch goes off or the app quits. One that just vanished (crash, sign-out, sleep) is caught by
  the heartbeat it already sends: `receivers` and `offer` skip a receiver whose `deviceLiveness`
  is older than 45 minutes. Removing a device or deleting the account deletes its rows too.
- Every function is an `authedQuery` / `authedMutation`: rows belong to the account, a phone can
  only reach desktops of its own account, and a desktop only sees offers addressed to it.
- ICE server configuration (`MURMUR_MIC_ICE_SERVERS`, JSON array of RTCIceServer, default the two
  public STUN servers) rides on the answers of `micLink.receivers` and `micLink.register`, which
  each side calls anyway: no extra call.

### Control: a data channel on the same peer connection

Reliable, ordered, JSON messages:

- phone → desktop: `hello` (phone name, protocol version), `start`, `stop`, `cancel`, `ping`.
- desktop → phone: `state` (`idle` / `listening` / `processing`, elapsed seconds), `level`
  (≤ 5 per second while listening), `result` (the inserted text's first 280 characters and word
  count), `error` (one sentence).

Start and stop on the phone drive the desktop's dictation exactly as the tray's toggle does (a
hands-free session). The desktop's own shortcut keeps working while a phone is linked and records
from the phone too: while a link is up, the phone *is* the desktop's microphone.

### Long sessions and failures

- WebRTC's own consent checks keep the path alive peer to peer; no server is involved after the
  answer, so Clerk token lifetimes and Convex reconnects cannot end a link.
- **A drop during a dictation keeps what was said.** ICE `disconnected` is often a Wi-Fi blip and
  recovers by itself; the dictation keeps running (the gap is silence). If the link is still down
  after 15 seconds, or fails outright, the desktop stops the dictation and transcribes everything
  it received, then falls back to its own microphone. The phone shows that it lost the desktop and
  offers to reconnect (a new offer/answer: seven more calls).
- Only a dictation that is recording the phone ends with the link. One the desktop started on
  its own microphone before a phone linked finishes on that microphone, whatever the link does,
  and the capture switches to the phone only once the link is connected, so an offer that never
  connects (given up after 35 seconds) cannot leave the desktop recording silence.
- The phone keeps its screen awake while linked (Screen Wake Lock on the web; the existing
  foreground recording service on Android).
- Recording length is bounded only by the desktop's existing settings (`Limit session length`)
  and memory: the recorder buffer is ~1.9 MB per minute, and long dictations are already
  transcribed in pieces while you talk.

### Scale

Backend work is O(links), not O(audio): ~7 function calls and ~10 KB of transient rows per link,
and zero for idle desktops. A million hour-long links a month is ~7M function calls and no audio
bandwidth on Murmur's side; media scales with the users' own networks. The one cost that can grow
with audio is a TURN relay, which is optional, per-operator and only for networks where direct and
STUN paths fail.

## Pieces

| Piece | Where |
| --- | --- |
| Protocol (messages, limits, SDP tuning), shared by every client | `packages/backend/convex/lib/micProtocol.ts` |
| Signaling functions and tables | `packages/backend/convex/micLink.ts`, `schema.ts` |
| Desktop: setting, signaling, link lifecycle, dictation control | `apps/desktop/src/main/phone-mic/` |
| Desktop: peer connection and the remote track as the microphone | `apps/desktop/src/renderer/src/overlay/phone-link.ts`, `capture.ts` |
| Desktop: switch and link status | Microphone page (`pages/Audio.tsx`) |
| Phone (any browser, iPhone included) | website, `/mic` |
| Phone (Android app) | `apps/android/.../phonemic/` |

The website page is the universal phone client: it needs no install, works on iPhones (Murmur has
no iOS app) and is how the whole path is tested end to end in CI-less local runs (a headless
Chromium with a fake microphone plays the phone; the desktop's renderer code runs in a second
page).

## Ephemeris

Ephemeris takes `apps/desktop` and `packages/backend` from Murmur with `scripts/sync-murmur.mjs`,
so the backend tables and functions, the main-process module, the overlay code and the Microphone
page arrive with the next sync. Its own `main/index.ts` and `preload/index.ts` need the same few
lines Murmur's got (create `PhoneMicHost`, expose `phoneMic` to the settings window). Its phone
side is Murmur's website page, signed in to the same Clerk account.

## Not in this version

- Choosing which of several linked phones is the microphone (the newest link wins; an older link
  is closed).
- Sending audio from the desktop back to the phone, or using the phone's speaker.
- A TURN service run by Murmur. Operators can configure one; the default is STUN only.
