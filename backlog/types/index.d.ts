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
    backlog: {
      /** This project's backlog. */
      backlog: Backlog
      /** What the person is typing into the field. */
      draft: string
      /** Whether "Очистить всё" waits for its second press. */
      clearing: boolean
      /** The project's folder name, under the heading. */
      project: string
    }
  }
}
