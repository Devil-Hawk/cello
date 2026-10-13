// The roles a person chooses a model for. Plain data, so the pages can import it without the model clients.

export const ROLES = ['chat', 'researcher', 'writer', 'worker'] as const
export type Role = (typeof ROLES)[number]

/** What the Settings page and the line under an answer call each role. */
export const ROLE_LABELS: Record<Role, string> = { chat: 'Chat', researcher: 'Research', writer: 'Writing', worker: 'Background work' }
