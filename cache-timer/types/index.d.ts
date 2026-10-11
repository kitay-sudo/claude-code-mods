/**
 * What the row above the prompt shows, recomputed on every tick and after
 * every response of the main conversation.
 */
export type CacheGauge = {
  /** Whole minutes until the cache cools, rounded up; 0 once it has; null with nothing cached yet. */
  minutesLeft: number | null
  /** Input tokens the last response was answered over; null before the first, or right after compaction. */
  tokens: number | null
  /** The model's context window, in tokens. */
  window: number
}

declare module 'claude-code' {
  interface PluginState {
    'cache-timer': {
      /** When the last main-conversation request that came back was sent, in `$.clock.now()` ms. */
      lastAt: number | null
      /** The `lastAt` the warning toast was already shown for. */
      warnedFor: number | null
      gauge: CacheGauge
      isCompacting: boolean
    }
  }
}
