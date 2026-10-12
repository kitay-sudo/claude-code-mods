export type StepStatus = 'pending' | 'in_progress' | 'completed'

/** One step of the model's plan, from its todo list or its task tools. */
export type Step = {
  id: string
  title: string
  status: StepStatus
}

/** The task the panel follows: a /goal, or what the person asked for. */
/** What a task is for, agreed before its plan: the goal and the checks that say it is done. */
export type Intent = {
  goal: string
  criteria: { text: string; met: boolean }[]
}

export type Task = {
  title: string
  isGoal: boolean
  /** When the task began, in `$.clock.now()` ms. */
  startedAt: number
  /** When it ended: every step done, or a turn without a plan answered; null while it runs. */
  finishedAt: number | null
  steps: Step[]
  /** The goal and its "done when" checks, once the model stated them; null before. */
  intent: Intent | null
}

/** A prompt typed while Claude was working, waiting to be read. */
export type Queued = {
  id: string
  text: string
  /** When it was typed, in `$.clock.now()` ms. */
  at: number
  /** Sent to wait for the task to end (ctrl+x enter), not to be read after the current step. */
  wait: boolean
}

/** One thing to do later in this project, kept between chats. */
export type BacklogItem = {
  id: string
  text: string
  /** When it was added, in `$.clock.now()` ms. */
  at: number
  by: 'person' | 'claude'
}

/** An item taken off the list: finished, or no longer needed. Kept a while so it can come back. */
export type ClosedItem = BacklogItem & {
  /** When it was closed, in `$.clock.now()` ms. */
  closedAt: number
  how: 'done' | 'dropped'
}

/** The project's backlog: its items, the ones closed lately, and the number the next id takes. */
export type Backlog = {
  items: BacklogItem[]
  closed: ClosedItem[]
  next: number
}

declare module 'claude-code' {
  interface PluginState {
    'task-panel': {
      task: Task | null
      /** The clock as of the last tick, so the minutes shown move. */
      now: number
      isWorking: boolean
      /** Prompts typed mid-turn that the model has not read yet, oldest first. */
      queue: Queued[]
      /** When the main turn last ended, so a queue nobody took can be dropped. */
      idleSince: number
      /** Actions of the main thread on the task at hand, for a task without a plan. */
      actions: number
      /** Whether the model was reminded to plan this task. */
      nudged: boolean
      /** This project's backlog. */
      backlog: Backlog
      /** What the person is typing into the backlog field. */
      backlogDraft: string
      /** Whether "очистить всё" waits for its second press. */
      backlogClearing: boolean
    }
  }
}
