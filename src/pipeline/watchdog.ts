/**
 * Inactivity watchdog — fires `onTimeout` if `touch()` is not called within
 * `inactivityMs` of the previous activity. Used by the streaming executor to
 * kill child processes (Claude Code, Codex) that have produced no stdout or
 * stderr for too long.
 *
 * Why this exists (SAM-400): the agent-worker daemon occasionally spawns a
 * Claude Code session that produces zero bytes on either stream for many
 * minutes, then either eventually unblocks or hits the hard timeout. The
 * watchdog catches the silent-hang case much earlier than the hard timeout
 * would, so the daemon can fail-and-retry the ticket within minutes instead
 * of waiting the full timeout window.
 *
 * Disabled when `inactivityMs <= 0`. The returned controller is a no-op in
 * that case — touch() and cancel() do nothing, onTimeout never fires. Pass
 * 0 to opt out without conditional code at the call site.
 */
export interface WatchdogController {
  /** Reset the inactivity timer. Call on every byte/chunk of process activity. */
  touch(): void;
  /** Stop the watchdog without firing. Call when the process has exited. */
  cancel(): void;
}

export function createWatchdog(opts: {
  inactivityMs: number;
  onTimeout: () => void;
}): WatchdogController {
  // 0, negative, or non-finite all mean "disabled". Returning a no-op
  // controller lets call sites use the same shape regardless of config.
  if (!Number.isFinite(opts.inactivityMs) || opts.inactivityMs <= 0) {
    return { touch: () => {}, cancel: () => {} };
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;

  function arm() {
    if (cancelled) return;
    timer = setTimeout(() => {
      timer = null;
      opts.onTimeout();
    }, opts.inactivityMs);
  }

  arm();

  return {
    touch() {
      if (cancelled) return;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      arm();
    },
    cancel() {
      cancelled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
