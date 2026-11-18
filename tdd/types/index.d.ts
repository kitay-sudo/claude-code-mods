/** How the gates act in a project: they do nothing, only say so, or refuse. */
export type Gates = 'off' | 'observe' | 'enforce'

/** What the gates remember of this session's work. */
export type Run = {
  /** A test file was touched since the last commit. */
  testTouched: boolean
  /** Code was edited since the tests last ran green. */
  dirty: boolean
  /** Code edits since the tests last ran green. */
  edits: number
  /** Failed test runs in a row. */
  redStreak: number
  /** How many times the commit gate refused since the last commit: the third attempt passes. */
  commitRefusals: number
  /** The person said "без тестов": the gates let it through until their next message. */
  skip: boolean
  /** When the tests last ran green, in ms. */
  lastGreen: number | null
}

declare module 'claude-code' {
  interface PluginState {
    tdd: {
      /** What the gates remember of this session's work. */
      run: Run
      /** How the gates act in this project: off, observe, enforce. */
      gates: Gates
      /** Whether the rules block stands in the project's CLAUDE.md; unknown until looked. */
      rule: 'unknown' | 'added' | 'absent'
      /** The project's test command as package.json names it, or null. */
      testCommand: string | null
      /** The project's folder name, under the heading. */
      project: string
    }
  }
}
