/** What a project's development has cost, kept across sessions. */
export type ProjectSpend = {
  usd: number
  /** Dollars by local day, YYYY-MM-DD. */
  days: Record<string, number>
  /** The first day counted, YYYY-MM-DD. */
  since: string
  /** A spending cap for the project, in rubles; null when none. */
  budgetRub: number | null
  /**
   * What has been added from each run of a session, by the run's start
   * (`$.session.usage().startedAt`): a run is counted whole once, a resumed
   * one only for what it costs after.
   */
  counted: Record<string, number>
  /** Time spent on the project by local day, in ms: Claude at work, and the person's pauses up to the idle limit. */
  time: Record<string, number>
  /** The last activity in any chat of the project, in ms: a gap is counted once, however many chats run. */
  lastActive: number
}

/** One usage window of the subscription, as the last response reported it. */
export type Limit = {
  kind: string
  percent: number
  resetsAt?: string
}

/** What the block and the pane draw. */
export type SpendView = {
  /** What this session has cost, in dollars; null where the host keeps no ledger. */
  sessionUsd: number | null
  project: ProjectSpend
  limits: Limit[]
  /** Today, YYYY-MM-DD, as the figures were counted. */
  today: string
}

/** The session's cost as last read, and the run it was read in. */
export type Seen = {
  run: string
  usd: number
}

/** What the person typed into the pane, not yet applied. */
export type SpendDraft = {
  budget: string
  error: string
}

declare module 'claude-code' {
  interface PluginState {
    'spend-meter': {
      view: SpendView
      seen: Seen | null
      /** Thresholds already warned about: `limit:five_hour:80@<resetsAt>`, `budget:100`. */
      warned: string[]
      draft: SpendDraft
      project: string
      /** Whether a turn of this chat is running. */
      isWorking: boolean
    }
  }
}
