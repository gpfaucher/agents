import type { RoleConfig } from "./roles/index.js";
import { queryIssues, moveIssue } from "./tools/linear.js";
import { invokeAgent } from "./agent.js";
import { getRepoForIssue, ensureRepoCloned, type RepoContext } from "./lib/repos.js";
import { getWaitTimeMs, isWarning } from "./lib/rate-limiter.js";
import { sendAlert } from "./lib/alerting.js";
import { cleanupStaleWorktrees, cleanupWorktree } from "./lib/worktree-cleanup.js";

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 2 * 60 * 1000;
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT) || 1;
const MAX_RETRIES = Number(process.env.MAX_RETRIES) || 2;
const WORK_WINDOW_ENABLED = process.env.WORK_WINDOW_ENABLED !== "false";

type IssueInfo = { id: string; identifier: string; title: string; stateName: string; labels: string[]; priority: number };

/** Issues currently being worked on — prevents double-pickup */
const activeIssues = new Set<string>();

/** Repos currently being worked on — prevents concurrent conflicts (Fix 9) */
const activeRepos = new Map<string, string>(); // repoName → issueIdentifier

/** Failure count per issue — for retry logic (Fix 4) */
const failureCounts = new Map<string, number>();

async function poll(role: RoleConfig) {
  // Check rate limit before picking up work
  if (WORK_WINDOW_ENABLED) {
    const waitMs = getWaitTimeMs();
    if (waitMs > 0) {
      const waitMin = Math.ceil(waitMs / 60_000);
      console.log(`[${role.displayName}] Rate limited — pausing for ${waitMin}m (resets at ${new Date(Date.now() + waitMs).toISOString()})`);
      return;
    }
  }

  try {
    // queryIssues already returns results sorted by priority (urgent first)
    const issues = await queryIssues(role.pollerFilter);
    console.log(`[${role.displayName}] Poll found ${issues.length} issue(s)`);

    const onHoldState = (process.env.STATUS_ON_HOLD || "On Hold").toLowerCase();

    for (const issue of issues) {
      if (activeIssues.has(issue.id)) continue;

      // On Hold tickets: only pick up if this agent put it on hold (has "hold:<role>" label)
      if (issue.stateName.toLowerCase() === onHoldState) {
        if (!role.holdLabel || !issue.labels.includes(role.holdLabel.toLowerCase())) {
          continue; // Not our ticket to resume
        }
      }

      // skipQA: if this role is the tester and the issue has "skipqa" label, auto-advance
      if (role.name === "tester" && issue.labels.includes("skipqa")) {
        console.log(
          `[${role.displayName}] Skipping QA for ${issue.identifier} (skipQA label) — auto-advancing to ${role.doneState}`,
        );
        try {
          await moveIssue(issue.id, role.doneState);
        } catch {
          console.warn(`[${role.displayName}] Could not auto-advance ${issue.identifier}`);
        }
        continue;
      }

      // Resolve which repo this issue belongs to (via "repo:<name>" label)
      const repoCtx = getRepoForIssue(issue.labels);
      if (!repoCtx) {
        console.warn(
          `[${role.displayName}] No repo:* label found for ${issue.identifier} (or label not in REPO_MAP), skipping`,
        );
        continue;
      }

      // Fix 9: Repo-level locking — prevent concurrent work on the same repo
      if (activeRepos.has(repoCtx.repoName)) {
        const blockedBy = activeRepos.get(repoCtx.repoName);
        console.log(
          `[${role.displayName}] Repo ${repoCtx.repoName} locked by ${blockedBy}, deferring ${issue.identifier}`,
        );
        continue;
      }

      // In warning state, only pick up urgent/high priority issues
      if (WORK_WINDOW_ENABLED && isWarning() && issue.priority > 2) {
        console.log(
          `[${role.displayName}] Rate limit warning — deferring non-urgent ${issue.identifier} (priority ${issue.priority})`,
        );
        continue;
      }

      // Respect concurrency limit
      if (activeIssues.size >= MAX_CONCURRENT) {
        console.log(
          `[${role.displayName}] At concurrency limit (${MAX_CONCURRENT}), deferring ${issue.identifier} (priority ${issue.priority})`,
        );
        break; // Issues are sorted by priority, so remaining ones are lower priority
      }

      // Check retry limit (Fix 4)
      const failures = failureCounts.get(issue.identifier) ?? 0;
      if (failures >= MAX_RETRIES) {
        console.log(
          `[${role.displayName}] ${issue.identifier} has failed ${failures} times, skipping (max retries: ${MAX_RETRIES})`,
        );
        continue;
      }

      console.log(
        `[${role.displayName}] Picking up ${issue.identifier}: ${issue.title} (repo: ${repoCtx.githubRepo}, priority: ${issue.priority}${failures > 0 ? `, retry #${failures + 1}` : ""})`,
      );
      activeIssues.add(issue.id);
      activeRepos.set(repoCtx.repoName, issue.identifier);

      // Try to move to in-progress state (acts as a lock if Linear is writable)
      try {
        await moveIssue(issue.id, role.inProgressState);
      } catch (err) {
        console.warn(
          `[${role.displayName}] Could not move ${issue.identifier} to ${role.inProgressState} (read-only?), proceeding anyway`,
        );
      }

      // Process the issue (don't await — let the poller continue for other issues)
      processIssue(role, issue, repoCtx).finally(() => {
        activeIssues.delete(issue.id);
        activeRepos.delete(repoCtx.repoName);
      });
    }
  } catch (err) {
    console.error(`[${role.displayName}] Polling error:`, err);
  }
}

async function processIssue(
  role: RoleConfig,
  issue: IssueInfo,
  repoCtx: RepoContext,
) {
  // Clone/fetch the repo before starting
  try {
    console.log(`[${role.displayName}] Syncing repo ${repoCtx.githubRepo} before starting ${issue.identifier}`);
    await ensureRepoCloned(repoCtx);
  } catch (err) {
    console.warn(
      `[${role.displayName}] Repo sync failed (continuing anyway):`,
      err instanceof Error ? err.message : String(err),
    );
  }

  // Detect if this ticket is returning from review (Builder picking up "In Development" that was previously reviewed)
  const isReturningFromReview =
    role.name === "engineer" &&
    issue.stateName.toLowerCase() === (process.env.STATUS_IN_DEVELOPMENT || "In Development").toLowerCase();

  const reviewHint = isReturningFromReview
    ? `\n\nThis ticket may be returning from review with requested changes. Check the Linear comments for a PR link — if one exists, use gh_get_pr_review_comments to fetch the review feedback and address each comment. Follow step 1b in your workflow.`
    : "";

  const prompt = `You have been assigned Linear issue ${issue.identifier}: "${issue.title}".

Repository: ${repoCtx.githubRepo} (cloned at ${repoCtx.repoDir})

Fetch the full issue details using linear_get_issue, then follow your workflow to complete the task.

Issue identifier: ${issue.identifier}${reviewHint}`;

  try {
    console.log(`[${role.displayName}] Starting work on ${issue.identifier} in ${repoCtx.githubRepo}`);
    const result = await invokeAgent(prompt, role, repoCtx);

    // Clear failure count on success
    failureCounts.delete(issue.identifier);

    // Log cost to console
    const durationStr = `${Math.round(result.durationMs / 1000)}s`;
    console.log(
      `[${role.displayName}] Completed ${issue.identifier}: ${result.numTurns} turns, $${result.costUsd.toFixed(2)}, ${durationStr}`,
    );

    // Post completion comment on Linear
    try {
      const { LinearClient } = await import("@linear/sdk");
      const client = new LinearClient({ apiKey: process.env.LINEAR_API_KEY! });
      const minutes = Math.round(result.durationMs / 60_000);
      await client.createComment({
        issueId: issue.id,
        body: `**${role.displayName} completed** — ${result.numTurns} turns, $${result.costUsd.toFixed(2)}, ${minutes}m`,
      });
    } catch {
      // Best effort
    }

    // Auto-save completion to knowledge base (system-level, doesn't rely on agent remembering)
    if (process.env.QDRANT_URL) {
      try {
        const { knowledgeStoreFromSystem } = await import("./tools/knowledge.js");
        await knowledgeStoreFromSystem({
          content: `${role.displayName} (${role.name}) completed ${issue.identifier}: "${issue.title}". ${result.numTurns} turns, $${result.costUsd.toFixed(2)}. Result: ${result.text.slice(0, 500)}`,
          category: "solution",
          repo: repoCtx.githubRepo.split("/").pop(),
          issueIdentifier: issue.identifier,
        });
      } catch {
        // Best effort — don't block completion
      }
    }

    // Report to dashboard if configured
    const dashboardUrl = process.env.DASHBOARD_URL;
    if (dashboardUrl) {
      try {
        await fetch(`${dashboardUrl}/api/runs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentRole: role.name,
            issueId: issue.id,
            issueIdentifier: issue.identifier,
            costUsd: result.costUsd,
            numTurns: result.numTurns,
            durationMs: result.durationMs,
            status: "completed",
          }),
        });
      } catch {
        // Best effort
      }
    }

    // Try to move to done state (unless the agent manages its own transitions)
    if (role.autoMoveToDone !== false) {
      try {
        await moveIssue(issue.id, role.doneState);
        console.log(
          `[${role.displayName}] Moved ${issue.identifier} to ${role.doneState}`,
        );
      } catch {
        console.warn(
          `[${role.displayName}] Could not move ${issue.identifier} to ${role.doneState} (read-only?)`,
        );
      }
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[${role.displayName}] Error processing ${issue.identifier}:`, err);

    // Fix 4: Track failures and retry
    const failures = (failureCounts.get(issue.identifier) ?? 0) + 1;
    failureCounts.set(issue.identifier, failures);

    // Fix 8: Clean up worktree on failure
    const branch = `agent/${issue.identifier}`;
    await cleanupWorktree(branch);

    // Fix 7: Alert on failure
    const alertMsg = failures >= MAX_RETRIES
      ? `${role.displayName} failed on ${issue.identifier} (${failures}/${MAX_RETRIES} retries exhausted): ${errMsg}`
      : `${role.displayName} failed on ${issue.identifier} (attempt ${failures}/${MAX_RETRIES}, will retry): ${errMsg}`;

    await sendAlert(alertMsg, {
      issue: issue.identifier,
      repo: repoCtx.githubRepo,
      agent: role.displayName,
      attempt: `${failures}/${MAX_RETRIES}`,
    });

    // Post failure comment on Linear
    try {
      const { LinearClient } = await import("@linear/sdk");
      const client = new LinearClient({ apiKey: process.env.LINEAR_API_KEY! });

      if (failures < MAX_RETRIES) {
        // Will retry — move back to pickup state
        await client.createComment({
          issueId: issue.id,
          body: `**${role.displayName} failed (attempt ${failures}/${MAX_RETRIES}, will retry):**\n\n\`\`\`\n${errMsg}\n\`\`\``,
        });
        // Move back so the poller picks it up again on next cycle
        try {
          const originalState = Array.isArray(role.pollerFilter.stateName)
            ? role.pollerFilter.stateName[0]
            : role.pollerFilter.stateName;
          await moveIssue(issue.id, originalState);
        } catch {
          // Best effort
        }
      } else {
        // Max retries exhausted — leave a permanent failure comment
        await client.createComment({
          issueId: issue.id,
          body: `**${role.displayName} failed after ${failures} attempts — giving up:**\n\n\`\`\`\n${errMsg}\n\`\`\`\n\nThis ticket needs manual attention.`,
        });
      }
    } catch {
      // Best effort
    }
  }
}

/**
 * Trigger immediate processing of a specific issue (called by webhook handler).
 * Returns true if the issue was picked up, false if skipped.
 */
export async function triggerIssue(
  role: RoleConfig,
  issueId: string,
  issueIdentifier: string,
): Promise<boolean> {
  if (activeIssues.has(issueId)) {
    console.log(`[${role.displayName}] Webhook trigger: ${issueIdentifier} already active, skipping`);
    return false;
  }

  // Fetch full issue details from Linear
  const { LinearClient } = await import("@linear/sdk");
  const client = new LinearClient({ apiKey: process.env.LINEAR_API_KEY! });

  const issue = await client.issue(issueId);
  const state = await issue.state;
  const labels = await issue.labels();
  const labelNames: string[] = [];
  for (const l of labels.nodes) {
    const parent = await l.parent;
    labelNames.push((parent ? `${parent.name}:${l.name}` : l.name).toLowerCase());
  }

  const issueInfo: IssueInfo = {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    stateName: state?.name ?? "Unknown",
    labels: labelNames,
    priority: issue.priority,
  };

  // Check if this issue matches our role's filter
  const stateNames = Array.isArray(role.pollerFilter.stateName)
    ? role.pollerFilter.stateName
    : [role.pollerFilter.stateName];
  const stateMatch = stateNames.some(
    (s) => s.toLowerCase() === issueInfo.stateName.toLowerCase(),
  );
  if (!stateMatch) {
    console.log(`[${role.displayName}] Webhook trigger: ${issueIdentifier} state '${issueInfo.stateName}' doesn't match our filter, skipping`);
    return false;
  }

  if (role.pollerFilter.label) {
    const hasLabel = issueInfo.labels.includes(role.pollerFilter.label.toLowerCase());
    if (!hasLabel) {
      console.log(`[${role.displayName}] Webhook trigger: ${issueIdentifier} missing label '${role.pollerFilter.label}', skipping`);
      return false;
    }
  }

  const repoCtx = getRepoForIssue(issueInfo.labels);
  if (!repoCtx) {
    console.log(`[${role.displayName}] Webhook trigger: ${issueIdentifier} no matching repo label, skipping`);
    return false;
  }

  // Check repo lock
  if (activeRepos.has(repoCtx.repoName)) {
    console.log(`[${role.displayName}] Webhook trigger: ${issueIdentifier} repo ${repoCtx.repoName} locked, skipping`);
    return false;
  }

  // Check concurrency
  if (activeIssues.size >= MAX_CONCURRENT) {
    console.log(`[${role.displayName}] Webhook trigger: at concurrency limit, skipping ${issueIdentifier}`);
    return false;
  }

  console.log(`[${role.displayName}] Webhook trigger: picking up ${issueIdentifier}`);
  activeIssues.add(issueInfo.id);
  activeRepos.set(repoCtx.repoName, issueInfo.identifier);

  try {
    await moveIssue(issueInfo.id, role.inProgressState);
  } catch {
    // Continue anyway
  }

  processIssue(role, issueInfo, repoCtx).finally(() => {
    activeIssues.delete(issueInfo.id);
    activeRepos.delete(repoCtx.repoName);
  });

  return true;
}

export async function startPoller(role: RoleConfig) {
  // Fix 8: Clean up stale worktrees on startup
  await cleanupStaleWorktrees();

  const stateNames = Array.isArray(role.pollerFilter.stateName)
    ? role.pollerFilter.stateName.join("' or '")
    : role.pollerFilter.stateName;
  console.log(
    `[${role.displayName}] Starting poller — checking for '${stateNames}'${role.pollerFilter.label ? ` with label '${role.pollerFilter.label}'` : ""} every ${POLL_INTERVAL_MS / 1000}s (max concurrent: ${MAX_CONCURRENT})`,
  );

  // Initial poll immediately
  poll(role);

  // Then poll on interval
  setInterval(() => poll(role), POLL_INTERVAL_MS);
}
