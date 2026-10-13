/** The parts of a passport, in the order the pane shows them. */
export type Section = 'client' | 'project' | 'rules' | 'places'

/** One fact or nuance of the project: who, what, how, where. Never a secret. */
export type Note = {
  id: string
  section: Section
  text: string
  /** When it was written, in `$.clock.now()` ms. */
  at: number
  /** The person in the pane, Claude through the tool, or (0.7.0 only) picked from the chat. */
  by: 'person' | 'claude' | 'chat'
}

/** What a button of the pane hands to Claude: fill and sort once, update any time. */
export type Ask = 'fill' | 'sort' | 'update'

/** What the project's passport holds. */
export type Passport = {
  /** The language messages to the client are written in; null when not set. */
  replyLanguage: 'ru' | 'en' | 'ru+en' | null
  notes: Note[]
  /** The next note number. */
  next: number
  /** When Claude last finished each request, in ms; null while never. */
  ran: Record<Ask, number | null>
}

/** How the passport behaves, the same in every project. */
export type PassportSettings = {
  /** Open the pane when a session starts in a project that has a passport. */
  autoOpen: boolean
  /** Ask before a note the model writes is kept. */
  askBeforeAdd: boolean
}

/** What the person typed into the add-a-note form. */
export type NoteDraft = {
  section: Section
  text: string
  error: string
}

declare module 'claude-code' {
  interface PluginState {
    'project-passport': {
      passport: Passport
      settings: PassportSettings
      draft: NoteDraft
      /** The note waiting for its second press to be deleted, or null. */
      confirming: string | null
      /** The project's folder name, for the pane's title. */
      project: string
      /** The last request a button handed to Claude, and when: shown under the buttons, a repeat soon after ignored. */
      asked: { what: Ask; at: number } | null
      /** The request Claude is working on now, and its turn. */
      running: { what: Ask; turnId: string } | null
    }
  }
}
