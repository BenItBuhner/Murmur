/**
 * Live integration tests against a real OpenAI-compatible endpoint.
 *
 *   MURMUR_LIVE=1 MURMUR_BASE_URL=https://host/v1 MURMUR_API_KEY=... \
 *   MURMUR_STT_MODEL=groq-whisper MURMUR_LLM_MODEL=complete npm run test:live
 *
 * They are excluded from the default `npm test` run.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getSttProvider } from '@core/stt'
import { chatComplete, listChatModels } from '@core/llm/client'
import { decodeWavPcm16, encodeWavPcm16 } from '@core/audio/wav'
import { analyze, trimSilence } from '@core/audio/vad'
import { buildSttPrompt } from '@core/text/dictionary'
import { buildFormatMessages, maxTokensFor, sanitizeLlmOutput } from '@core/text/llm-prompt'
import { runPipeline } from '@core/text/pipeline'
import { classifyApp, resolveStyle } from '@core/text/app-context'
import { defaultSettings } from '@shared/settings'

const baseUrl = process.env.MURMUR_BASE_URL ?? ''
const apiKey = process.env.MURMUR_API_KEY ?? ''
const sttModel = process.env.MURMUR_STT_MODEL ?? 'whisper-1'
const llmModel = process.env.MURMUR_LLM_MODEL ?? ''
const enabled = !!process.env.MURMUR_LIVE && !!baseUrl

const fixture = readFileSync(resolve(__dirname, '../../resources/fixtures/jfk.wav'))
const EXPECTED = /ask not what your country can do for you/i

describe.skipIf(!enabled)('live endpoint', () => {
  it('lists models', async () => {
    const provider = getSttProvider('openai-compatible')
    const models = await provider.listModels({
      kind: 'openai-compatible',
      baseUrl,
      apiKey,
      model: '',
      language: 'auto',
      timeoutMs: 20000
    })
    expect(models.length).toBeGreaterThan(0)
    console.log(
      `[live] ${models.length} models, speech-ranked first: ${models.slice(0, 5).join(', ')}`
    )
  })

  it('transcribes the JFK fixture and reports latency', async () => {
    const provider = getSttProvider('openai-compatible')
    const wav = new Uint8Array(fixture)
    const res = await provider.transcribe(
      {
        wav,
        prompt: buildSttPrompt([
          { id: '1', word: 'Americans', aliases: [], fuzzy: false, createdAt: 0 }
        ])
      },
      {
        kind: 'openai-compatible',
        baseUrl,
        apiKey,
        model: sttModel,
        language: 'auto',
        timeoutMs: 60000
      }
    )
    console.log(
      `[live] stt=${sttModel} latency=${res.latencyMs}ms text="${res.text}" lang=${res.language ?? '?'} noSpeech=${res.noSpeechProb?.toFixed(3) ?? 'n/a'}`
    )
    expect(res.text).toMatch(EXPECTED)
    expect(res.latencyMs).toBeLessThan(30000)
  })

  it('VAD trimming keeps the speech and shrinks the upload', async () => {
    const decoded = decodeWavPcm16(new Uint8Array(fixture))
    const analysis = analyze(decoded.pcm, { sampleRate: decoded.sampleRate, thresholdDb: -48 })
    expect(analysis.hasSpeech).toBe(true)
    const trimmed = trimSilence(decoded.pcm, {
      sampleRate: decoded.sampleRate,
      thresholdDb: -48,
      paddingMs: 250
    })
    const wav = encodeWavPcm16(trimmed.pcm, decoded.sampleRate)
    console.log(
      `[live] fixture ${decoded.pcm.length} samples -> trimmed ${trimmed.pcm.length} (start -${trimmed.trimmedStartMs.toFixed(0)}ms, end -${trimmed.trimmedEndMs.toFixed(0)}ms)`
    )
    const provider = getSttProvider('openai-compatible')
    const res = await provider.transcribe(
      { wav },
      {
        kind: 'openai-compatible',
        baseUrl,
        apiKey,
        model: sttModel,
        language: 'en',
        timeoutMs: 60000
      }
    )
    console.log(`[live] trimmed stt latency=${res.latencyMs}ms text="${res.text}"`)
    expect(res.text).toMatch(EXPECTED)
  })

  it('returns a clear model error with suggestions for a bogus model', async () => {
    const provider = getSttProvider('openai-compatible')
    await expect(
      provider.transcribe(
        { wav: new Uint8Array(fixture) },
        {
          kind: 'openai-compatible',
          baseUrl,
          apiKey,
          model: 'definitely-not-a-model',
          language: 'auto',
          timeoutMs: 30000
        }
      )
    ).rejects.toMatchObject({ name: 'SttError' })
  })

  it.skipIf(!llmModel)(
    'smart-formats a messy transcript with the LLM and passes the guard',
    async () => {
      const raw =
        'um so hey can you uh send the report to john on tuesday no wednesday and um also like cc sarah on it thanks'
      const light = runPipeline(raw, {
        removeFillers: true,
        fillerWords: ['um', 'uh'],
        hesitations: 'light',
        hesitationPhrases: [],
        collapseRepeats: true,
        repetitionScope: 'phrases',
        spokenCommands: true,
        selfCorrections: true,
        autoCapitalize: true,
        trailingSpace: false,
        pressEnterCommand: true,
        lists: 'auto',
        listStyle: 'auto',
        bulletMarker: '-',
        numbers: 'smart',
        dictionary: [],
        snippets: []
      })
      const app = classifyApp('slack.exe', 'general - Slack')
      const messages = buildFormatMessages({
        raw: light.text,
        dictionary: [{ id: '1', word: 'Sarah', aliases: [], fuzzy: false, createdAt: 0 }],
        style: resolveStyle({ ...defaultSettings().formatting, tone: 'casual' }, app),
        app,
        hints: light.hints
      })
      const res = await chatComplete(
        { baseUrl, apiKey, model: llmModel, timeoutMs: 30000 },
        messages,
        { maxTokens: maxTokensFor(raw) }
      )
      const guard = sanitizeLlmOutput(res.text, raw)
      console.log(
        `[live] llm=${llmModel} latency=${res.latencyMs}ms light="${light.text}" smart="${guard.text}" ok=${guard.ok}`
      )
      expect(guard.ok).toBe(true)
      expect(guard.text).toMatch(/Wednesday/)
      expect(guard.text).not.toMatch(/\bum\b|\buh\b|Tuesday/i)
      expect(guard.text).toMatch(/Sarah/)
    }
  )

  it.skipIf(!llmModel)('lists chat models', async () => {
    const models = await listChatModels({ baseUrl, apiKey })
    expect(models).toContain(llmModel)
  })
})
