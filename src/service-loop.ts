import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import type { Runtime, RenewResult, Message } from "./runtime.js";
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

export interface ForcePollResult {
  polled: string[];
  messagesReceived: number;
}

export interface ServiceLoop {
  start(): void;
  stop(): Promise<void>;
  getHealth(): ServiceHealth;
  addSession(sessionId: string): void;
  removeSession(sessionId: string): void;
  forcePoll(sessionId?: string): Promise<ForcePollResult>;
}

const MAX_SKIP_CYCLES = 6;

interface SessionTracker {
  cursor: string | undefined;
  consecutiveErrors: number;
  lastPollAt: string | null;
  state: SessionPollState;
  skipUntilCycle: number;
  expiresAt: Date | null;
  ttl: number | null;
}

function newTracker(): SessionTracker {
  return {
    cursor: undefined,
    consecutiveErrors: 0,
    lastPollAt: null,
    state: "joining",
    skipUntilCycle: 0,
    expiresAt: null,
    ttl: null,
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

    // Post-poll expiry estimation: if messages were received and TTL is known,
    // the server has reset the sliding window, so estimate new expiresAt
    if (result.messages.length > 0 && tracker.ttl !== null) {
      tracker.expiresAt = new Date(Date.now() + tracker.ttl * 1000);
    }

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
        const rejoinResult = await config.runtime.join(sessionId);
        tracker.cursor = undefined;
        tracker.consecutiveErrors = 0;
        tracker.state = "polling";
        if (rejoinResult.expiresAt) {
          tracker.expiresAt = new Date(rejoinResult.expiresAt);
        }
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

    // Renewal pass — renew sessions approaching expiry BEFORE polling
    const now = Date.now();
    for (const sid of eligible) {
      const tracker = trackers.get(sid);
      if (
        tracker &&
        tracker.expiresAt !== null &&
        tracker.state !== "backoff" &&
        now + config.pollIntervalMs * 2 >= tracker.expiresAt.getTime()
      ) {
        try {
          const renewResult = await config.runtime.renew(sid);
          tracker.expiresAt = new Date(renewResult.expiresAt);
          tracker.ttl = renewResult.ttl;
        } catch (renewErr: unknown) {
          console.warn(
            `[nexus-messaging] Renewal failed for session ${sid} (will still attempt poll):`,
            renewErr
          );
          // Do NOT increment errors or enter backoff — poll will detect actual death
        }
      }
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
          const tracker = trackers.get(config.sessions[i]);
          if (!tracker) continue;
          const res = results[i];
          if (res.status === "rejected") {
            tracker.consecutiveErrors = 1;
            tracker.state = "backoff";
            tracker.skipUntilCycle = currentCycle + 2;
          } else if (res.value.expiresAt) {
            tracker.expiresAt = new Date(res.value.expiresAt);
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
        config.runtime.join(sessionId).then((result) => {
          if (result.expiresAt) {
            tracker.expiresAt = new Date(result.expiresAt);
          }
        }).catch(() => {
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

    async forcePoll(sessionId?: string): Promise<ForcePollResult> {
      let targets: string[];
      if (sessionId !== undefined) {
        if (!trackers.has(sessionId)) {
          return { polled: [], messagesReceived: 0 };
        }
        targets = [sessionId];
      } else {
        targets = [...trackers.keys()];
      }

      if (targets.length === 0) {
        return { polled: [], messagesReceived: 0 };
      }

      for (const sid of targets) {
        const tracker = trackers.get(sid);
        if (tracker) {
          tracker.skipUntilCycle = 0;
        }
      }

      const results = await Promise.allSettled(
        targets.map((sid) => pollOne(sid))
      );

      const batch = new Map<string, Message[]>();
      const polled: string[] = [];
      let messagesReceived = 0;

      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const sid = targets[i];

        if (result.status === "fulfilled") {
          polled.push(sid);
          if (result.value.messages.length > 0) {
            batch.set(sid, result.value.messages);
            messagesReceived += result.value.messages.length;
          }
        } else {
          await handlePollError(sid, result.reason);
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

      return { polled, messagesReceived };
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
