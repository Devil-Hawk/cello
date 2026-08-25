// Application pipeline stages
export const PIPELINE_STAGES = [
  'discovered',
  'applied',
  'screen',
  'interview',
  'offer',
  'closed',
  'ghosted',
  'rejected',
] as const

export type PipelineStage = (typeof PIPELINE_STAGES)[number]

// Ghost detection thresholds (in days)
export const GHOST_THRESHOLDS = {
  WARNING: 7,      // Show warning indicator
  FOLLOW_UP: 14,   // Suggest following up
  GHOSTED: 20,     // Auto-move to ghosted
} as const

// Scrape frequencies
export const SCRAPE_FREQUENCIES = {
  HIGH: 5,        // Every 5 minutes (dream companies)
  MEDIUM: 15,     // Every 15 minutes (default)
  LOW: 60,        // Every hour (less priority)
} as const

// Match score thresholds
export const MATCH_THRESHOLDS = {
  EXCELLENT: 85,
  GOOD: 70,
  FAIR: 50,
} as const
