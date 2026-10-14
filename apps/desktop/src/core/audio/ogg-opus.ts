/**
 * Ogg Opus packaging for uploads. Opus at 16 kbit/s is ~19x smaller than 16 kHz PCM WAV with the
 * same recognition accuracy (5 min bench: WER 0.054 for both), so a five-minute dictation uploads ~0.5 MB
 * instead of ~9 MB. The encoder is injected so this file stays pure and testable.
 */

const OPUS_RATE = 48_000
/** Samples per Opus frame at 16 kHz (20 ms). */
export const FRAME_16K = 320
/** Standard encoder lookahead at 48 kHz; decoders drop this many samples from the front. */
const PRE_SKIP = 312
/** Packets gathered into one Ogg page (about one second of audio). */
const PACKETS_PER_PAGE = 50

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let r = i << 24
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1
    t[i] = r >>> 0
  }
  return t
})()

function crc32(bytes: Uint8Array): number {
  let crc = 0
  for (let i = 0; i < bytes.length; i++)
    crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ bytes[i]) & 0xff]) >>> 0
  return crc
}

function page(
  packets: Uint8Array[],
  granule: number,
  seq: number,
  serial: number,
  flags: number
): Uint8Array {
  const lacing: number[] = []
  for (const p of packets) {
    let n = p.length
    while (n >= 255) {
      lacing.push(255)
      n -= 255
    }
    lacing.push(n)
  }
  const bodyLen = packets.reduce((s, p) => s + p.length, 0)
  const out = new Uint8Array(27 + lacing.length + bodyLen)
  const view = new DataView(out.buffer)
  out.set([0x4f, 0x67, 0x67, 0x53], 0)
  out[5] = flags
  view.setUint32(6, granule % 2 ** 32, true)
  view.setUint32(10, Math.floor(granule / 2 ** 32), true)
  view.setUint32(14, serial, true)
  view.setUint32(18, seq, true)
  out[26] = lacing.length
  out.set(lacing, 27)
  let at = 27 + lacing.length
  for (const p of packets) {
    out.set(p, at)
    at += p.length
  }
  view.setUint32(22, crc32(out), true)
  return out
}

/** Wrap Opus packets (20 ms each, mono, encoded at `inputRate`) in an Ogg Opus file. */
export function muxOggOpus(
  packets: Uint8Array[],
  inputRate: number,
  samplesPerPacket = FRAME_16K
): Uint8Array {
  if (packets.some((p) => p.length > 255 * 254))
    throw new Error('Opus packet too large for one page')
  const serial = 0x4d524d52 // "MRMR"
  const head = new Uint8Array(19)
  head.set(new TextEncoder().encode('OpusHead'), 0)
  const hv = new DataView(head.buffer)
  head[8] = 1
  head[9] = 1
  hv.setUint16(10, PRE_SKIP, true)
  hv.setUint32(12, inputRate, true)
  const vendor = new TextEncoder().encode('murmur')
  const tags = new Uint8Array(8 + 4 + vendor.length + 4)
  tags.set(new TextEncoder().encode('OpusTags'), 0)
  new DataView(tags.buffer).setUint32(8, vendor.length, true)
  tags.set(vendor, 12)
  const pages = [page([head], 0, 0, serial, 0x02), page([tags], 0, 1, serial, 0)]
  const step = (samplesPerPacket * OPUS_RATE) / inputRate
  let granule = PRE_SKIP
  let seq = 2
  for (let i = 0; i < packets.length; i += PACKETS_PER_PAGE) {
    const group = packets.slice(i, i + PACKETS_PER_PAGE)
    granule += group.length * step
    const last = i + PACKETS_PER_PAGE >= packets.length
    pages.push(page(group, granule, seq++, serial, last ? 0x04 : 0))
  }
  const total = pages.reduce((s, p) => s + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of pages) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** Encodes one 20 ms frame of 16 kHz mono PCM. */
export type FrameEncoder = (frame: Int16Array) => Uint8Array

/** Encode 16 kHz mono PCM into an Ogg Opus file; the final partial frame is zero-padded. */
export function encodeOggOpus(pcm: Int16Array, encode: FrameEncoder): Uint8Array {
  const packets: Uint8Array[] = []
  for (let i = 0; i < pcm.length; i += FRAME_16K) {
    let frame = pcm.subarray(i, i + FRAME_16K)
    if (frame.length < FRAME_16K) {
      const padded = new Int16Array(FRAME_16K)
      padded.set(frame)
      frame = padded
    }
    packets.push(encode(frame))
  }
  return muxOggOpus(packets, 16_000)
}
