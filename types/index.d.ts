/** One piece of background work the stopped agent is waiting on. */
export type WaitTask = {
  id: string
  /** What the task does, as the model or the agent's own description says. */
  label: string
  /** When the work was handed to the background, or first seen if earlier. */
  startedAt: number
  /** The modification time of its output file, when the host names one. */
  outputAt?: number
}

/** What the row above the prompt shows while the agent is stopped. */
export type Wait =
  | { kind: 'none' }
  | { kind: 'stopped' }
  | { kind: 'waiting'; headline: string; tasks: WaitTask[]; wakeups: number; since: number; now: number }

declare module 'claude-code' {
  interface PluginState {
    'shell-insight': { wait: Wait }
  }
}
