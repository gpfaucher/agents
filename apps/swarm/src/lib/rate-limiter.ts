/**
 * Tracks rate limit state from SDK rate_limit_event messages.
 * Used by the poller to pause/resume work based on API usage limits.
 */

export type RateLimitStatus = "ok" | "warning" | "rejected";

interface RateLimitState {
  status: RateLimitStatus;
  resetsAt: number | null;
  utilization: number | null;
  lastUpdated: number;
}

const state: RateLimitState = {
  status: "ok",
  resetsAt: null,
  utilization: null,
  lastUpdated: Date.now(),
};

/**
 * Update rate limit state from an SDK rate_limit_event message.
 */
export function updateRateLimitState(event: {
  rate_limit_info: {
    status: "allowed" | "allowed_warning" | "rejected";
    resetsAt?: number;
    utilization?: number;
  };
}): void {
  const info = event.rate_limit_info;
  const prev = state.status;

  if (info.status === "rejected") {
    state.status = "rejected";
  } else if (info.status === "allowed_warning") {
    state.status = "warning";
  } else {
    state.status = "ok";
  }

  state.resetsAt = info.resetsAt ?? null;
  state.utilization = info.utilization ?? null;
  state.lastUpdated = Date.now();

  if (prev !== state.status) {
    console.log(
      `[rate-limit] Status changed: ${prev} → ${state.status}` +
        (state.resetsAt ? ` (resets at ${new Date(state.resetsAt * 1000).toISOString()})` : "") +
        (state.utilization != null ? ` (utilization: ${Math.round(state.utilization * 100)}%)` : ""),
    );
  }
}

/**
 * Check if the system should pause before picking up new work.
 * Returns the number of milliseconds to wait, or 0 if ready.
 */
export function getWaitTimeMs(): number {
  if (state.status !== "rejected" || !state.resetsAt) return 0;

  const now = Date.now() / 1000;
  const waitSeconds = state.resetsAt - now;

  if (waitSeconds <= 0) {
    // Reset has passed, clear the rejection
    state.status = "ok";
    state.resetsAt = null;
    return 0;
  }

  return Math.ceil(waitSeconds * 1000);
}

/**
 * Whether the system is in a warning state (high utilization).
 * The poller can use this to defer lower-priority work.
 */
export function isWarning(): boolean {
  return state.status === "warning";
}

/**
 * Get current rate limit state for logging/dashboard.
 */
export function getRateLimitState(): Readonly<RateLimitState> {
  return { ...state };
}
