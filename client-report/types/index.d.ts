/** The report last written, as the pane shows it. */
export type Report = {
  text: string
  /** When it was written, in `$.clock.now()` ms. */
  at: number
  /** What it covers, in words: "с 09.10", "за последние 7 дней". */
  period: string
  /** Where the period starts, in ms: "Заново" keeps it. */
  since: number
  isEnglish: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'client-report': {
      report: Report | null
      /** What is being written now, or null. */
      busy: string | null
      /** Why the last attempt gave nothing, or ''. */
      note: string
    }
  }
}
