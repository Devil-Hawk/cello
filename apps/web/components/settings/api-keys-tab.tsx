'use client'

import { useState } from 'react'
import { CheckCircle, Eye, EyeOff, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface ApiKeys {
  openai?: string
  anthropic?: string
  openrouter?: string
}

type Provider = 'openai' | 'anthropic' | 'openrouter'

export interface ApiKeysTabProps {
  initialHasOpenai: boolean
  initialHasAnthropic: boolean
  initialHasOpenrouter: boolean
  onStatus: (status: 'success' | 'error', message: string) => void
}

interface KeyFieldProps {
  label: string
  configured: boolean
  value: string
  onChange: (value: string) => void
  placeholder: string
  onRemove: () => void
  isSaving: boolean
  helpText: React.ReactNode
}

function KeyField({
  label,
  configured,
  value,
  onChange,
  placeholder,
  onRemove,
  isSaving,
  helpText,
}: KeyFieldProps) {
  const [show, setShow] = useState(false)

  return (
    <div className="rounded-card border bg-card p-4">
      <div className="mb-2 flex items-center justify-between">
        <label className="text-body font-medium text-foreground">{label}</label>
        {configured && (
          <span className="flex items-center gap-1 text-caption text-emerald-600 dark:text-emerald-400">
            <CheckCircle className="h-3 w-3" />
            Configured
          </span>
        )}
      </div>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <input
            type={show ? 'text' : 'password'}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className={cn(
              'flex h-9 w-full rounded-control border border-input bg-card px-3 py-1 pr-10 font-mono text-body text-foreground transition-colors',
              'placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background'
            )}
            placeholder={configured ? '••••••••••••••••' : placeholder}
          />
          <button
            type="button"
            onClick={() => setShow(!show)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            aria-label={show ? 'Hide key' : 'Show key'}
          >
            {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
        {configured && (
          <Button
            variant="outline"
            size="sm"
            onClick={onRemove}
            disabled={isSaving}
            className="h-9 text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-500/10"
          >
            Remove
          </Button>
        )}
      </div>
      <p className="mt-2 text-caption text-muted-foreground">{helpText}</p>
    </div>
  )
}

/**
 * API key management. Only "configured" booleans are ever shown — key values
 * never round-trip from the server. Save/delete request shapes match
 * /api/settings/keys exactly.
 */
export function ApiKeysTab({
  initialHasOpenai,
  initialHasAnthropic,
  initialHasOpenrouter,
  onStatus,
}: ApiKeysTabProps) {
  const [openaiKey, setOpenaiKey] = useState('')
  const [anthropicKey, setAnthropicKey] = useState('')
  const [openrouterKey, setOpenrouterKey] = useState('')
  const [hasOpenaiKey, setHasOpenaiKey] = useState(initialHasOpenai)
  const [hasAnthropicKey, setHasAnthropicKey] = useState(initialHasAnthropic)
  const [hasOpenrouterKey, setHasOpenrouterKey] = useState(initialHasOpenrouter)
  const [isSaving, setIsSaving] = useState(false)

  async function saveApiKeys() {
    setIsSaving(true)

    // Build payload with only non-empty keys
    const payload: ApiKeys = {}

    if (openaiKey && !openaiKey.includes('•')) {
      if (!openaiKey.startsWith('sk-')) {
        onStatus('error', 'OpenAI key should start with sk-')
        setIsSaving(false)
        return
      }
      payload.openai = openaiKey
    }

    if (anthropicKey && !anthropicKey.includes('•')) {
      if (!anthropicKey.startsWith('sk-ant-')) {
        onStatus('error', 'Anthropic key should start with sk-ant-')
        setIsSaving(false)
        return
      }
      payload.anthropic = anthropicKey
    }

    if (openrouterKey && !openrouterKey.includes('•')) {
      if (!openrouterKey.startsWith('sk-or-')) {
        onStatus('error', 'OpenRouter key should start with sk-or-')
        setIsSaving(false)
        return
      }
      payload.openrouter = openrouterKey
    }

    try {
      const response = await fetch('/api/settings/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      const result = await response.json()

      if (result.error) {
        onStatus('error', result.error)
      } else {
        onStatus('success', 'API keys saved securely (encrypted)')
        setHasOpenaiKey(result.hasOpenai)
        setHasAnthropicKey(result.hasAnthropic)
        setHasOpenrouterKey(result.hasOpenrouter)
        setOpenaiKey('')
        setAnthropicKey('')
        setOpenrouterKey('')
      }
    } catch {
      onStatus('error', 'Failed to save API keys')
    }

    setIsSaving(false)
  }

  async function deleteApiKey(provider: Provider) {
    setIsSaving(true)

    try {
      const response = await fetch(`/api/settings/keys?provider=${provider}`, {
        method: 'DELETE',
      })

      if (response.ok) {
        if (provider === 'openai') setHasOpenaiKey(false)
        if (provider === 'anthropic') setHasAnthropicKey(false)
        if (provider === 'openrouter') setHasOpenrouterKey(false)
        const providerName =
          provider === 'openai' ? 'OpenAI' : provider === 'anthropic' ? 'Anthropic' : 'OpenRouter'
        onStatus('success', `${providerName} key removed`)
      }
    } catch {
      onStatus('error', 'Failed to remove API key')
    }

    setIsSaving(false)
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-display text-section text-foreground">API keys</h2>
        <p className="mt-1 text-caption text-muted-foreground">
          Add your own API keys to enable AI-powered features like career page verification, job
          matching, and resume analysis. Keys are encrypted at rest and never shared.
        </p>
      </div>

      <div className="space-y-4">
        <KeyField
          label="OpenAI API key"
          configured={hasOpenaiKey}
          value={openaiKey}
          onChange={setOpenaiKey}
          placeholder="sk-..."
          onRemove={() => deleteApiKey('openai')}
          isSaving={isSaving}
          helpText={
            <>
              Get your key from{' '}
              <a
                href="https://platform.openai.com/api-keys"
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent-deep hover:underline"
              >
                platform.openai.com
              </a>
            </>
          }
        />

        <KeyField
          label="Anthropic API key"
          configured={hasAnthropicKey}
          value={anthropicKey}
          onChange={setAnthropicKey}
          placeholder="sk-ant-..."
          onRemove={() => deleteApiKey('anthropic')}
          isSaving={isSaving}
          helpText={
            <>
              Get your key from{' '}
              <a
                href="https://console.anthropic.com/settings/keys"
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent-deep hover:underline"
              >
                console.anthropic.com
              </a>
            </>
          }
        />

        <KeyField
          label="OpenRouter API key"
          configured={hasOpenrouterKey}
          value={openrouterKey}
          onChange={setOpenrouterKey}
          placeholder="sk-or-..."
          onRemove={() => deleteApiKey('openrouter')}
          isSaving={isSaving}
          helpText={
            <>
              Get your key from{' '}
              <a
                href="https://openrouter.ai/keys"
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent-deep hover:underline"
              >
                openrouter.ai
              </a>{' '}
              — access 100+ models with one API
            </>
          }
        />

        <div className="pt-1">
          <Button
            onClick={saveApiKeys}
            disabled={isSaving || (!openaiKey && !anthropicKey && !openrouterKey)}
          >
            {isSaving && <Loader2 className="h-4 w-4 animate-spin" />}
            Save API keys
          </Button>
        </div>

        <div className="rounded-card bg-sunken p-4">
          <p className="text-body font-medium text-foreground">Why do I need API keys?</p>
          <ul className="mt-2 space-y-1 text-caption text-muted-foreground">
            <li>AI verification — confirm career pages are legitimate</li>
            <li>Job matching — score jobs against your resume</li>
            <li>Smart scraping — extract job details from any page format</li>
            <li>Insights — talking points and interview prep</li>
          </ul>
        </div>
      </div>
    </div>
  )
}
