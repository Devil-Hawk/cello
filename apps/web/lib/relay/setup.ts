// The lines a person follows to let Cello use a model on their own computer ("This
// computer"). Plain data, so Settings (PG4) and the Welcome choice render the same
// words. Nothing here runs anything.

import type { LocalRuntime } from './local'

export interface SetupGuide {
  runtime: LocalRuntime
  name: string
  /** Why a person would choose it, one sentence. */
  summary: string
  /** What to do, in order, one line each. */
  steps: string[]
  /** What it looks like when it works. */
  ready: string
}

/** `origin` is the address Cello runs at, for the one setting Ollama needs. */
export function setupGuide(runtime: LocalRuntime, origin: string): SetupGuide {
  if (runtime === 'ollama') {
    return {
      runtime,
      name: 'Ollama',
      summary: 'Runs free models on this computer. Cello asks it to write drafts and sort mail.',
      steps: [
        'Install Ollama from ollama.com.',
        'In a terminal, run: ollama pull llama3.1:8b',
        `Let Cello's address reach it: set OLLAMA_ORIGINS to ${origin} and restart Ollama.`,
        'Keep Ollama running while Cello is open.',
        'Your browser will ask once whether Cello may reach devices on your network. Allow it.',
      ],
      ready: 'Ollama is running here and Cello can reach it.',
    }
  }
  return {
    runtime,
    name: 'LM Studio',
    summary: 'Runs free models on this computer with a window you can see.',
    steps: [
      'Install LM Studio from lmstudio.ai and download a model.',
      'Open the Developer tab and start the local server.',
      `Turn on Enable CORS, so ${origin} may reach it.`,
      'Keep LM Studio running while Cello is open.',
      'Your browser will ask once whether Cello may reach devices on your network. Allow it.',
    ],
    ready: 'LM Studio is running here and Cello can reach it.',
  }
}

/** The sentence a step shows while its job waits for a carrier. */
export const WAITING_FOR_COMPUTER = 'Waiting for your computer'
export const WAITING_FOR_BROWSER = 'Waiting until Cello is open again'
