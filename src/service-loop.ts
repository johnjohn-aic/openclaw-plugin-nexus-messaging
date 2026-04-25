import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import type { Runtime, RenewResult, Message } from "./runtime.js";
import { RuntimeError } from "./runtime.js";

export function computeRenewalThreshold(pollIntervalMs: number): number {
  return Math.max(pollIntervalMs * 3, 120_000);
}

export function isTerminalRenewError(err: unknown): boolean {
  if (err instanceof RuntimeError) {
    return err.code === "session-expired" || err.code === "agent-not-in-session";
  }
  return false;
}

const MAX_SKIP_CYCLES = 6;

export interface SessionTracker {
  cursor: string | undefined;
  consecutiveErrors: number;
  lastPollAt: string | null;
  state: SessionPollState;
  skipUntilCycle: number;
  expiresAt: Date | null;
  ttl: number | null;
}

/** Outcome of attemptRenewal: indicates what happened and what the caller should do next. */
export interface RenewalOutcome {
  renewed: boolean;
  attempted: boolean;
  backoffReset: boolean;
  sentinelSet: boolean;
  lastError?: unknown;
}

/**
 * Attempts to renew a session with retry logic. Mutates tracker on success (expiresAt, ttl, backoff reset)
 * or on null+failure (writes sentinel). Returns outcome flags so caller knows if a warning should be emitted.
 */
export async function attemptRenewal(
  runtime: Runtime,
  sessionId: string,
  tracker: SessionTracker,
  now: number,
  pollIntervalMs: number
): Promise<RenewalOutcome> {
  const threshold = computeRenewalThreshold(pollIntervalMs);
  const needsRenewal = tracker.expiresAt === null || now + threshold >= tracker.expiresAt.getTime();

  if (!needsRenewal) {
    return { renewed: false, attempted: false, backoffReset: false, sentinelSet: false };
  }

  let renewSuccess = false;
  let renewResult: RenewResult | undefined;
  let lastError: unknown | undefined;

  try {
    renewResult = await runtime.renew(sessionId);
    renewSuccess = true;
  } catch (firstErr: unknown) {
    lastError = firstErr;
    if (!isTerminalRenewError(firstErr)) {
      await new Promise(r => setTimeout(r, 300));
      try {
        renewResult = await runtime.renew(sessionId);
        renewSuccess = true;
        lastError = undefined;
      } catch (retryErr: unknown) {
        lastError = retryErr;
      }
    }
  }

  const wasBackoff = tracker.state === "backoff";

  if (renewSuccess && renewResult) {
    tracker.expiresAt = new Date(renewResult.expiresAt);
    tracker.ttl = renewResult.ttl;
    if (wasBackoff) {
      tracker.consecutiveErrors = 0;
      tracker.skipUntilCycle = 0;
      tracker.state = "polling";
    }
    return {
      renewed: true,
      attempted: true,
      backoffReset: wasBackoff,
      sentinelSet: false,
    };
  }

  const sentinelSet = tracker.expiresAt === null;
  if (sentinelSet) {
    tracker.expiresAt = new Date(now + pollIntervalMs * 4);
  }
  return {
    renewed: false,
    attempted: true,
    backoffReset: false,
    sentinelSet,
    lastError,
  };
}

function buildHealthFilePath(agentName?: string): string {
  const suffix = agentName ? `-${agentName.replace(/[^a-zA-Z0-9_-]/g, "_")}` : "";
  return resolve(tmpdir(), `nexus-messaging-health${suffix}.json`);
}

function persistHealth(healthFile: string, health: ServiceHealth): void {
  try {
    writeFileSync(healthFile, JSON.stringify(health), "utf-8");
  } catch {
    // best-effort — /tmp should always be writable
  }
}

export function readPersistedHealth(agentName?: string): ServiceHealth | null {
  try {
    const healthFile = buildHealthFilePath(agentName);
    if (!existsSync(healthFile)) return null;
    const raw = readFileSync(healthFile, "utf-8");
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
  agentName?: string;
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
  const healthFile = buildHealthFilePath(config.agentName);
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

    // Renewal pass — scan ALL non-stopped/non-joining trackers regardless of skipUntilCycle.
    // This ensures backoff sessions blocked by skipUntilCycle are still reached for renewal.
    // When expiresAt is null, renewal is attempted as a self-healing path; on failure a
    // sentinel is written to prevent a tight retry loop on every subsequent tick.
    const now = Date.now();
    for (const [sid, tracker] of trackers) {
      if (tracker.state === "stopped" || tracker.state === "joining") continue;

      const outcome = await attemptRenewal(config.runtime, sid, tracker, now, config.pollIntervalMs);
      if (outcome.attempted && !outcome.renewed) {
        console.warn(
          `[nexus-messaging] Renewal failed for session ${sid} (will still attempt poll):`,
          outcome.lastError
        );
      }
    }

    // Compute eligible list AFTER the renewal pass so sessions reset from backoff
    // by a successful renew are included in the same tick's poll pass.
    const eligible: string[] = [];
    for (const [sessionId, tracker] of trackers) {
      if (tracker.skipUntilCycle <= cycle && tracker.state !== "stopped" && tracker.state !== "joining") {
        eligible.push(sessionId);
      }
    }

    if (eligible.length === 0) {
      persistHealth(healthFile, { state: loopState, sessions: buildSessionsSnapshot() });
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

    persistHealth(healthFile, { state: loopState, sessions: buildSessionsSnapshot() });
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
          } else {
            tracker.state = "polling";
            if (res.value.expiresAt) {
              tracker.expiresAt = new Date(res.value.expiresAt);
            }
          }
        }
        loopState = "running";
        tick();
        loopTimerId = setInterval(() => { tick(); }, config.pollIntervalMs);
        persistHealth(healthFile, { state: loopState, sessions: buildSessionsSnapshot() });
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
      persistHealth(healthFile, { state: loopState, sessions: buildSessionsSnapshot() });
    },

    addSession(sessionId: string): void {
      if (trackers.has(sessionId)) return;
      const tracker = newTracker();
      trackers.set(sessionId, tracker);

      if (loopState === "running") {
        tracker.state = "joining";
        config.runtime.join(sessionId).then((result) => {
          tracker.state = "polling";
          if (result.expiresAt) {
            tracker.expiresAt = new Date(result.expiresAt);
          }
        }).catch(() => {
          tracker.consecutiveErrors++;
          tracker.skipUntilCycle = currentCycle + 2;
          tracker.state = "backoff";
        });
      }

      persistHealth(healthFile, { state: loopState, sessions: buildSessionsSnapshot() });
    },

    removeSession(sessionId: string): void {
      trackers.delete(sessionId);
      persistHealth(healthFile, { state: loopState, sessions: buildSessionsSnapshot() });
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

      // Filter out sessions still joining (join not yet completed)
      const ready = targets.filter((sid) => {
        const t = trackers.get(sid);
        return t && t.state !== "joining";
      });

      if (ready.length === 0) {
        return { polled: [], messagesReceived: 0 };
      }

      const results = await Promise.allSettled(
        ready.map((sid) => pollOne(sid))
      );

      const batch = new Map<string, Message[]>();
      const polled: string[] = [];
      let messagesReceived = 0;

      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const sid = ready[i];

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
      persistHealth(healthFile, health);
      return health;
    },
  };
}
