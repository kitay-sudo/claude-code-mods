export type StepStatus = 'pending' | 'in_progress' | 'completed'

/** One step of the model's plan, from its todo list or its task tools. */
export type Step = {
  id: string
  title: string
  status: StepStatus
}

/** The task the panel follows: a /goal, or what the person asked for. */
export type Task = {
  title: string
  isGoal: boolean
  /** When the task began, in `$.clock.now()` ms. */
  startedAt: number
  /** When it ended: every step done, or a turn without a plan answered; null while it runs. */
  finishedAt: number | null
  steps: Step[]
}

declare module 'claude-code' {
  interface PluginState {
    'task-panel': {
      task: Task | null
      /** The clock as of the last tick, so the minutes shown move. */
      now: number
      isWorking: boolean
    }
  }
}
