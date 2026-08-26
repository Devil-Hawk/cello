// The one place the two A2A "agent card" shapes are described, so
// app/.well-known/agent-card.json/route.ts (the wire-shaped, classic v0.3
// AgentCard JSON — spec-shaped for a real A2A client) and
// app/api/a2a/route.ts (the internal, native v1.0-proto-shaped AgentCard
// @a2a-js/sdk's DefaultRequestHandler constructor requires) describe the
// SAME agent once instead of drifting apart.
//
// STREAMING/PUSH NOTIFICATIONS: both false. This route only wires the three
// classic, non-streaming JSON-RPC methods (message/send, tasks/get,
// tasks/cancel — spec Step 3, item 3); the compat handler itself throws
// `unsupportedOperation` for message/stream/tasks/resubscribe against an
// agent card that doesn't advertise streaming (see @a2a-js/sdk's
// LegacyJsonRpcTransportHandler.handle), so a client that tries anyway gets
// a loud JSON-RPC error, not a silent hang.

import type { AgentCard as NativeAgentCard } from '@a2a-js/sdk'
import { A2A_AGENTS } from './agent'

const SKILL_DESCRIPTIONS: Record<(typeof A2A_AGENTS)[number], string> = {
  matcher: 'Score already-tracked jobs (by id) against the caller\'s resume. Read-only — never applies.',
  company_researcher: 'Assemble a public-source company dossier (visa/sponsorship signal, summary) for an already-tracked company. Read-only.',
  interview_prep: 'Build an interview prep kit (questions + STAR stories) for an already-tracked job. Draft-only — never sends anything.',
}

const NAME = 'cello'
const DESCRIPTION =
  'Cello: read/draft-only job-search agents over A2A. matcher, company_researcher and interview_prep — none of these ' +
  'agents has a submit-capable code path (see lib/a2a/graph-shape.test.ts). Every field is an id into the caller\'s ' +
  'own already-tracked jobs/companies; no free-text job posting or resume override is accepted.'
const VERSION = '1.0.0'

const BEARER_SCHEME_NAME = 'bearer'

/** The classic, spec-shaped card served at /.well-known/agent-card.json —
 *  what a real A2A client parses. `url` is supplied by the caller (derived
 *  from the request itself, not a static env var — see that route's own
 *  comment) so this stays correct under any host it's deployed to. */
export function buildWireAgentCard(a2aUrl: string) {
  return {
    protocolVersion: '0.3',
    name: NAME,
    description: DESCRIPTION,
    url: a2aUrl,
    preferredTransport: 'JSONRPC',
    version: VERSION,
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    skills: A2A_AGENTS.map((id) => ({
      id,
      name: id,
      description: SKILL_DESCRIPTIONS[id],
      tags: ['job-search', 'read-only'],
      inputModes: ['application/json'],
      outputModes: ['application/json'],
    })),
    securitySchemes: {
      [BEARER_SCHEME_NAME]: { type: 'http', scheme: 'bearer', description: 'A Cello personal access token (scope: a2a). See Settings -> API Tokens.' },
    },
    security: [{ [BEARER_SCHEME_NAME]: [] }],
    supportsAuthenticatedExtendedCard: false,
  }
}

/** The internal, native v1.0-proto-shaped card @a2a-js/sdk's
 *  DefaultRequestHandler constructor requires — never served on the wire
 *  directly (see this file's header). */
export function buildNativeAgentCard(a2aUrl: string): NativeAgentCard {
  return {
    name: NAME,
    description: DESCRIPTION,
    supportedInterfaces: [{ url: a2aUrl, protocolBinding: 'JSONRPC', tenant: '', protocolVersion: '0.3' }],
    provider: undefined,
    version: VERSION,
    capabilities: { extensions: [], pushNotifications: false, streaming: false },
    securitySchemes: {
      [BEARER_SCHEME_NAME]: {
        scheme: { $case: 'httpAuthSecurityScheme', value: { description: 'A Cello personal access token (scope: a2a).', scheme: 'Bearer', bearerFormat: '' } },
      },
    },
    securityRequirements: [{ schemes: { [BEARER_SCHEME_NAME]: { list: [] } } }],
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    skills: A2A_AGENTS.map((id) => ({
      id,
      name: id,
      description: SKILL_DESCRIPTIONS[id],
      tags: ['job-search', 'read-only'],
      examples: [],
      inputModes: ['application/json'],
      outputModes: ['application/json'],
      securityRequirements: [],
    })),
    signatures: [],
  }
}
