/** A server of the project, reached over SSH with a key: no password is ever kept. */
export type Server = {
  /** A short name: `prod`, `stage`. */
  name: string
  /** Hostname or IP address. */
  host: string
  user: string
  port: number
  /** The remote folder commands run in; `~/app` style allowed. */
  dir?: string
  /** A private key file on this computer, when not the default one. */
  key?: string
  /** The command line that deploys the project there. */
  deploy?: string
  /** `after-push`: the deploy runs by itself after every successful `git push`. */
  deployMode?: 'manual' | 'after-push'
}

/** How the project's servers are worked with. */
export type PanelSettings = {
  /** Which of the model's commands the person confirms: all, or only the risky ones. */
  confirm: 'every' | 'risky'
  /** Whether the status row above the prompt is shown in this project. */
  band: boolean
}

/** One command run on a server, by the model or by the person's press. */
export type Run = {
  id: number
  server: string
  command: string
  by: 'claude' | 'person' | 'auto'
  /** When it started, in `$.clock.now()` ms. */
  at: number
  status: 'running' | 'done' | 'failed' | 'cancelled'
  exitCode: number | null
  /** The last lines of its output, for the panel. */
  tail: string
}

/** One service of the project on the server: a container or a pm2 process. */
export type Service = {
  name: string
  /** As its runtime says it: running, exited, restarting, online, stopped... */
  state: string
  /** pm2 restarts, when known. */
  restarts: number | null
}

/** What runs the project on the server, as the health check found it. */
export type Runtime = 'compose' | 'docker' | 'pm2' | 'systemd' | 'none'

/** The server's health from one read-only check. */
export type Vitals = {
  /** Load as a share of the processors, in %. */
  cpu: number | null
  memUsedMb: number | null
  memTotalMb: number | null
  diskPercent: number | null
  diskFreeMb: number | null
  runtime: Runtime
  services: Service[]
  /** The last error lines of the project's logs, newest last. */
  errors: string[]
  /** The project's own log files the errors were read from, newest first. */
  logFiles: string[]
  /** The project folder is not on the server. */
  isDirMissing: boolean
}

/** What the last connection check found. */
export type Health = {
  state: 'unknown' | 'checking' | 'ok' | 'fail'
  /** When it was checked, in `$.clock.now()` ms. */
  at: number | null
  /** How long the login took, in ms. */
  ms: number | null
  note: string
  /** The machine, the services and the log errors, from the last check that got in. */
  vitals?: Vitals
}

/** The connect assistant's progress for one server. */
export type Setup = {
  server: string
  step: 'key' | 'window' | 'done' | 'failed'
  note: string
}

/** What the person typed into the new-server form, not yet saved. */
export type Draft = {
  address: string
  dir: string
  deploy: string
  /** Why the last save of the form did not go through. */
  error: string
}

declare module 'claude-code' {
  interface PluginState {
    'server-panel': {
      servers: Server[]
      settings: PanelSettings
      runs: Run[]
      health: Record<string, Health>
      setup: Setup | null
      draft: Draft
      /** `<server>:<action>` waiting for its second press, or null. */
      confirming: string | null
      /** Whether the new-server form is open while servers already exist. */
      adding: boolean
    }
  }
}
