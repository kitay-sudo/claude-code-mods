/** A command the guard stopped, or the one the person said «да» to. */
export type PendingDeletion = {
  /** `Bash` or `PowerShell`. */
  tool: string
  /** The command, trimmed: only this exact text is let through. */
  command: string
}

declare module 'claude-code' {
  interface PluginState {
    'delete-guard': {
      /** The last command stopped, waiting for the person's answer. */
      pending: PendingDeletion | null
      /** The command the person said «да» to, until it runs once. */
      approved: PendingDeletion | null
    }
  }
}
