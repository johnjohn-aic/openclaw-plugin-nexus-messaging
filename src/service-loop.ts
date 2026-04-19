import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import type { Runtime, Message } from "./runtime.js";
import { RuntimeError } from "./runtime.js";

const HEALTH_FILE = resolve(tmpdir(), "nexus-messaging-health.json");

function persistHealth(health: ServiceHealth): void {
  try {
    writeFileSync(HEALTH_FILE, JSON.stringify(health), "utf-8");
  } catch {
    // best-effort — /tmp should always be writable
  }
}

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
  onMessage: (batch: Map<string, Message[]>) => void;
}

export interface ServiceLoop {
  start(): void;
  stop(): Promise<void>;
  getHealth(): ServiceHealth;
  addSession(sessionId: string): void;
  removeSession(sessionId: string): void;
}

const MAX_SKIP_CYCLES = 6;

interface SessionTracker {
  cursor: string | undefined;
  consecutiveErrors: number;
  lastPollAt: string | null;
  state: SessionPollState;
  skipUntilCycle: number;
}

function newTracker(): SessionTracker {
  return {
    cursor: undefined,
    consecutiveErrors: 0,
    lastPollAt: null,
    state: "joining",
    skipUntilCycle: 0,
  };
}

export function createServiceLoop(config: ServiceLoopConfig): ServiceLoop {
  let loopState: ServiceLoopState = "idle";
  const trackers = new Map<string, SessionTracker>();
  let loopTimerId: ReturnType<typeof setInterval> | null = null;
  let currentCycle: number = 0;

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

  async function pollOne(sessionId: string): Promise<{ sessionId: string; messages: Message[] }> {
    const tracker = trackers.get(sessionId);
    if (!tracker) return { sessionId, messages: [] };

    tracker.state = "polling";
    const result = await config.runtime.poll(sessionId, tracker.cursor);
    tracker.lastPollAt = new Date().toISOString();
    tracker.cursor = result.nextCursor;
    tracker.consecutiveErrors = 0;
    tracker.state = "polling";

    return { sessionId, messages: result.messages };
  }

  async function handlePollError(sessionId: string, err: unknown): Promise<void> {
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
      try {
        await config.runtime.join(sessionId);
        tracker.cursor = undefined;
        tracker.consecutiveErrors = 0;
        tracker.state = "polling";
        return;
      } catch (rejoinErr: unknown) {
        console.error(
          `[nexus-messaging] Auto-rejoin failed for session ${sessionId}:`,
          rejoinErr
        );
        tracker.consecutiveErrors++;
      }
    } else {
      console.error(
        `[nexus-messaging] Poll error for session ${sessionId}:`,
        err
      );
    }

    const skipCycles = Math.min(Math.pow(2, tracker.consecutiveErrors), MAX_SKIP_CYCLES);
    tracker.skipUntilCycle = currentCycle + skipCycles;
    tracker.state = "backoff";
  }

  async function tick(): Promise<void> {
    if (loopState !== "running") return;

    const cycle = currentCycle++;

    const eligible: string[] = [];
    for (const [sessionId, tracker] of trackers) {
      if (tracker.skipUntilCycle <= cycle && tracker.state !== "stopped") {
        eligible.push(sessionId);
      }
    }

    if (eligible.length === 0) {
      persistHealth({ state: loopState, sessions: buildSessionsSnapshot() });
      return;
    }

    const results = await Promise.allSettled(
      eligible.map((sid) => pollOne(sid))
    );

    const batch = new Map<string, Message[]>();

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const sessionId = eligible[i];

      if (result.status === "fulfilled") {
        if (result.value.messages.length > 0) {
          batch.set(sessionId, result.value.messages);
        }
      } else {
        await handlePollError(sessionId, result.reason);
      }
    }

    if (batch.size > 0) {
      try {
        config.onMessage(batch);
      } catch (cbErr: unknown) {
        console.error(
          `[nexus-messaging] onMessage callback error:`,
          cbErr
        );
      }
    }

    persistHealth({ state: loopState, sessions: buildSessionsSnapshot() });
  }

  return {
    start(): void {
      if (loopState !== "idle" && loopState !== "stopped") return;
      loopState = "starting";

      for (const sessionId of config.sessions) {
        trackers.set(sessionId, newTracker());
      }

      Promise.allSettled(
        config.sessions.map((sid) => config.runtime.join(sid))
      ).then((results) => {
        for (let i = 0; i < results.length; i++) {
          if (results[i].status === "rejected") {
            const tracker = trackers.get(config.sessions[i]);
            if (tracker) {
              tracker.consecutiveErrors = 1;
              tracker.state = "backoff";
              tracker.skipUntilCycle = currentCycle + 2;
            }
          }
        }
        loopState = "running";
        tick();
        loopTimerId = setInterval(() => { tick(); }, config.pollIntervalMs);
        persistHealth({ state: loopState, sessions: buildSessionsSnapshot() });
      });
    },

    async stop(): Promise<void> {
      if (loopState !== "running") return;
      loopState = "stopping";

      if (loopTimerId !== null) {
        clearInterval(loopTimerId);
        loopTimerId = null;
      }

      for (const tracker of trackers.values()) {
        tracker.state = "stopped";
      }

      loopState = "stopped";
      persistHealth({ state: loopState, sessions: buildSessionsSnapshot() });
    },

    addSession(sessionId: string): void {
      if (trackers.has(sessionId)) return;
      const tracker = newTracker();
      trackers.set(sessionId, tracker);

      if (loopState === "running") {
        tracker.state = "joining";
        config.runtime.join(sessionId).catch(() => {
          tracker.consecutiveErrors++;
          tracker.skipUntilCycle = currentCycle + 2;
          tracker.state = "backoff";
        });
      }

      persistHealth({ state: loopState, sessions: buildSessionsSnapshot() });
    },

    removeSession(sessionId: string): void {
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
