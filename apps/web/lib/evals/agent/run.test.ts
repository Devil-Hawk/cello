import { describe, expect, it } from 'vitest'
import { ScriptedChatModel, say } from '@/lib/agents/testing/scripted-model'
import { orchestrator } from './run'

describe('the orchestrator eval agent', () => {
  it('builds without an API key, because the Researcher gets the eval model too', () => {
    const model = new ScriptedChatModel({ model: 'x/y:free', script: [say('ok')] })
    expect(() => orchestrator(model)).not.toThrow()
  })
})
