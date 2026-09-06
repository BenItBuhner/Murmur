import type { SttProviderKind } from '@shared/settings'
import { DeepgramStt } from './deepgram'
import { ElevenLabsStt } from './elevenlabs'
import { OpenAiCompatibleStt } from './openai-compatible'
import type { SttProvider } from './types'

const providers: Record<SttProviderKind, SttProvider> = {
  'openai-compatible': new OpenAiCompatibleStt(),
  deepgram: new DeepgramStt(),
  elevenlabs: new ElevenLabsStt()
}

export function getSttProvider(kind: SttProviderKind): SttProvider {
  return providers[kind] ?? providers['openai-compatible']
}

export * from './types'
export * from './presets'
export * from './coverage'
