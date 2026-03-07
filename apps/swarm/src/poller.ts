import type { RoleConfig } from "./roles/index.js";
import { queryIssues, moveIssue } from "./tools/linear.js";
import { invokeAgent } from "./agent.js";
import { getRepoForIssue, ensureRepoCloned, type RepoContext } from "./lib/repos.js";

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 2 * 60 * 1000;
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT) || 1;

/** Issues currently being worked on — prevents double-pickup */
const activeIssues = new Set<string>();

async function poll(role: RoleConfig) {
  try {
    // queryIssues already returns results sorted by priority (urgent first)
    const issues = await queryIssues(role.pollerFilter);

    for (const issue of issues) {
      if (activeIssues.has(issue.id)) continue;

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

      // Respect concurrency limit
      if (activeIssues.size >= MAX_CONCURRENT) {
        console.log(
          `[${role.displayName}] At concurrency limit (${MAX_CONCURRENT}), deferring ${issue.identifier} (priority ${issue.priority})`,
        );
        break; // Issues are sorted by priority, so remaining ones are lower priority
      }

      console.log(
        `[${role.displayName}] Picking up ${issue.identifier}: ${issue.title} (repo: ${repoCtx.githubRepo}, priority: ${issue.priority})`,
      );
      activeIssues.add(issue.id);

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
      });
    }
  } catch (err) {
    console.error(`[${role.displayName}] Polling error:`, err);
  }
}

async function processIssue(
  role: RoleConfig,
  issue: { id: string; identifier: string; title: string; stateName: string; labels: string[]; priority: number },
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

  const prompt = `You have been assigned Linear issue ${issue.identifier}: "${issue.title}".

Repository: ${repoCtx.githubRepo} (cloned at ${repoCtx.repoDir})

Fetch the full issue details using linear_get_issue, then follow your workflow to complete the task.

Issue identifier: ${issue.identifier}`;

  try {
    console.log(`[${role.displayName}] Starting work on ${issue.identifier} in ${repoCtx.githubRepo}`);
    const result = await invokeAgent(prompt, role, repoCtx);

    // Log cost to console
    const durationStr = `${Math.round(result.durationMs / 1000)}s`;
    console.log(
      `[${role.displayName}] Completed ${issue.identifier}: ${result.numTurns} turns, $${result.costUsd.toFixed(2)}, ${durationStr}`,
    );

    // Post cost summary as Linear comment
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
    console.error(
      `[${role.displayName}] Error processing ${issue.identifier}:`,
      err,
    );
    // Try to add a comment about the failure
    try {
      const { LinearClient } = await import("@linear/sdk");
      const client = new LinearClient({ apiKey: process.env.LINEAR_API_KEY! });
      await client.createComment({
        issueId: issue.id,
        body: `**${role.displayName} agent failed:**\n\n\`\`\`\n${err instanceof Error ? err.message : String(err)}\n\`\`\``,
      });
    } catch {
      // Best effort
    }
  }
}

export function startPoller(role: RoleConfig) {
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
