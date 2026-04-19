import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import type { Runtime, Message } from "./runtime.js";
import { RuntimeError } from "./runtime.js";

/**
 * Health state file path — shared between the gateway process (writes)
 * and the CLI process (reads). Uses /tmp so it works in containers.
 */
const HEALTH_FILE = resolve(tmpdir(), "nexus-messaging-health.json");

function persistHealth(health: ServiceHealth): void {
  try {
    writeFileSync(HEALTH_FILE, JSON.stringify(health), "utf-8");
  } catch {
    // best-effort — /tmp should always be writable
  }
}

/**
 * Read persisted health from disk. Used by CLI commands that run
 * in a separate process and can't access in-memory state.
 */
export function readPersistedHealth(): ServiceHealth | null {
  try {
    if (!existsSync(HEALTH_FILE)) return null;
    const raw = readFileSync(HEALTH_FILE, "utf-8");
    return JSON.parse(raw) as ServiceHealth;
  } catch {
    return null;
  }
}

export type ServiceLoopState =
  | "idle"
  | "starting"
  | "running"
  | "stopping"
  | "stopped";

export type SessionPollState =
  | "joining"
  | "polling"
  | "backoff"
  | "stopped";

export interface SessionHealth {
  state: SessionPollState;
  lastPollAt: string | null;
  cursor: string | undefined;
  consecutiveErrors: number;
}

export interface ServiceHealth {
  state: ServiceLoopState;
  sessions: Record<string, SessionHealth>;
}

export interface ServiceLoopConfig {
  runtime: Runtime;
  sessions: string[];
  pollIntervalMs: number;
  autoRejoin: boolean;
  onMessage: (sessionId: string, messages: Message[]) => void;
}

export interface ServiceLoop {
  start(): void;
  stop(): Promise<void>;
  getHealth(): ServiceHealth;
  /** Add a session to the poll loop at runtime (hot-reload). No-op if already tracked. */
  addSession(sessionId: string): void;
  /** Remove a session from the poll loop at runtime. */
  removeSession(sessionId: string): void;
}

const MAX_BACKOFF_MS = 300_000;

interface SessionTracker {
  timerId: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout> | null;
  timerKind: "interval" | "timeout" | null;
  cursor: string | undefined;
  consecutiveErrors: number;
  lastPollAt: string | null;
  state: SessionPollState;
}

export function createServiceLoop(config: ServiceLoopConfig): ServiceLoop {
  let loopState: ServiceLoopState = "idle";
  const trackers = new Map<string, SessionTracker>();

  function buildSessionsSnapshot(): Record<string, SessionHealth> {
    const sessions: Record<string, SessionHealth> = {};
    for (const [sessionId, tracker] of trackers) {
      sessions[sessionId] = {
        state: tracker.state,
        lastPollAt: tracker.lastPollAt,
        cursor: tracker.cursor,
        consecutiveErrors: tracker.consecutiveErrors,
      };
    }
    return sessions;
  }

  function clearSessionTimer(sessionId: string): void {
    const tracker = trackers.get(sessionId);
    if (!tracker || tracker.timerId === null) return;
    if (tracker.timerKind === "interval") {
      clearInterval(tracker.timerId as ReturnType<typeof setInterval>);
    } else if (tracker.timerKind === "timeout") {
      clearTimeout(tracker.timerId as ReturnType<typeof setTimeout>);
    }
    tracker.timerId = null;
    tracker.timerKind = null;
  }

  function clearAllTimers(): void {
    for (const sessionId of trackers.keys()) {
      clearSessionTimer(sessionId);
    }
  }

  function scheduleSteadyPoll(sessionId: string): void {
    const tracker = trackers.get(sessionId);
    if (!tracker) return;
    clearSessionTimer(sessionId);
    tracker.state = "polling";
    tracker.timerId = setInterval(
      () => pollSession(sessionId),
      config.pollIntervalMs
    );
    tracker.timerKind = "interval";
  }

  function applyBackoff(sessionId: string, retryFn: () => void): void {
    const tracker = trackers.get(sessionId);
    if (!tracker) return;
    clearSessionTimer(sessionId);
    tracker.state = "backoff";
    const delay = Math.min(
      config.pollIntervalMs * Math.pow(2, tracker.consecutiveErrors),
      MAX_BACKOFF_MS
    );
    tracker.timerId = setTimeout(retryFn, delay);
    tracker.timerKind = "timeout";
  }

  function joinAndStartPolling(sessionId: string): void {
    const tracker = trackers.get(sessionId);
    if (!tracker) return;
    tracker.state = "joining";
    config.runtime
      .join(sessionId)
      .then(() => {
        if (loopState !== "running") return;
        scheduleSteadyPoll(sessionId);
      })
      .catch((err: unknown) => {
        if (loopState !== "running") return;
        console.error(
          `[nexus-messaging] Failed to join session ${sessionId}:`,
          err
        );
        tracker.consecutiveErrors++;
        applyBackoff(sessionId, () => joinAndStartPolling(sessionId));
      });
  }

  function pollSession(sessionId: string): void {
    const tracker = trackers.get(sessionId);
    if (!tracker) return;
    const cursor = tracker.cursor;
    config.runtime
      .poll(sessionId, cursor)
      .then((result) => {
        if (loopState !== "running") return;
        tracker.lastPollAt = new Date().toISOString();
        tracker.cursor = result.nextCursor;
        // Persist health to disk so CLI process can read it
        persistHealth({ state: loopState, sessions: buildSessionsSnapshot() });
        if (result.messages.length > 0) {
          try {
            config.onMessage(sessionId, result.messages);
          } catch (cbErr: unknown) {
            console.error(
              `[nexus-messaging] onMessage callback error for session ${sessionId}:`,
              cbErr
            );
          }
        }
        if (tracker.consecutiveErrors > 0) {
          tracker.consecutiveErrors = 0;
          scheduleSteadyPoll(sessionId);
        }
      })
      .catch((err: unknown) => {
        if (loopState !== "running") return;
        handlePollError(sessionId, err);
      });
  }

  function handlePollError(sessionId: string, err: unknown): void {
    const tracker = trackers.get(sessionId);
    if (!tracker) return;
    tracker.consecutiveErrors++;
    tracker.lastPollAt = new Date().toISOString();

    if (
      config.autoRejoin &&
      err instanceof RuntimeError &&
      (err.code === "session-expired" || err.code === "agent-not-in-session")
    ) {
      console.error(
        `[nexus-messaging] Session ${sessionId} error (${err.code}), attempting auto-rejoin`
      );
      tracker.state = "joining";
      config.runtime
        .join(sessionId)
        .then(() => {
          if (loopState !== "running") return;
          tracker.cursor = undefined;
          tracker.consecutiveErrors = 0;
          scheduleSteadyPoll(sessionId);
        })
        .catch((rejoinErr: unknown) => {
          if (loopState !== "running") return;
          console.error(
            `[nexus-messaging] Auto-rejoin failed for session ${sessionId}:`,
            rejoinErr
          );
          tracker.consecutiveErrors++;
          applyBackoff(sessionId, () => joinAndStartPolling(sessionId));
        });
      return;
    }

    console.error(
      `[nexus-messaging] Poll error for session ${sessionId}:`,
      err
    );
    applyBackoff(sessionId, () => pollSession(sessionId));
  }

  return {
    start(): void {
      if (loopState !== "idle" && loopState !== "stopped") return;
      loopState = "starting";
      for (const sessionId of config.sessions) {
        const tracker: SessionTracker = {
          timerId: null,
          timerKind: null,
          cursor: undefined,
          consecutiveErrors: 0,
          lastPollAt: null,
          state: "joining",
        };
        trackers.set(sessionId, tracker);
        joinAndStartPolling(sessionId);
      }
      loopState = "running";
      persistHealth({ state: loopState, sessions: buildSessionsSnapshot() });
    },

    async stop(): Promise<void> {
      if (loopState !== "running") return;
      loopState = "stopping";
      clearAllTimers();
      for (const tracker of trackers.values()) {
        tracker.state = "stopped";
      }
      loopState = "stopped";
      persistHealth({ state: loopState, sessions: buildSessionsSnapshot() });
    },

    addSession(sessionId: string): void {
      if (trackers.has(sessionId)) return;
      const tracker: SessionTracker = {
        timerId: null,
        timerKind: null,
        cursor: undefined,
        consecutiveErrors: 0,
        lastPollAt: null,
        state: "joining",
      };
      trackers.set(sessionId, tracker);
      if (loopState === "running") {
        joinAndStartPolling(sessionId);
      }
    },

    removeSession(sessionId: string): void {
      clearSessionTimer(sessionId);
      trackers.delete(sessionId);
      persistHealth({ state: loopState, sessions: buildSessionsSnapshot() });
    },

    getHealth(): ServiceHealth {
      const sessions: Record<string, SessionHealth> = {};
      for (const [sessionId, tracker] of trackers) {
        sessions[sessionId] = {
          state: tracker.state,
          lastPollAt: tracker.lastPollAt,
          cursor: tracker.cursor,
          consecutiveErrors: tracker.consecutiveErrors,
        };
      }
      const health: ServiceHealth = { state: loopState, sessions };
      persistHealth(health);
      return health;
    },
  };
}
