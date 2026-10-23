import type { DraftImage } from './images'

export interface BtwTurn {
  question: string
  answer?: string
  error?: string
}

/** The `/btw` panel: several turns on one fork, thrown away when the panel closes. */
export interface BtwChat {
  turns: BtwTurn[]
  busy: boolean
}

export interface QueuedMessage {
  id: string
  text: string
  images: DraftImage[]
  /** A slash command waiting for the run to end, not a message for pi. */
  command?: boolean
}
