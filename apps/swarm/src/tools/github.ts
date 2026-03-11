import { tool } from "@anthropic-ai/claude-agent-sdk";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const exec = promisify(execFile);

async function installDeps(dir: string) {
  // JS/TS dependencies
  if (existsSync(join(dir, "package.json"))) {
    let cmd: string;
    let args: string[];
    if (existsSync(join(dir, "bun.lockb")) || existsSync(join(dir, "bun.lock"))) {
      cmd = "bun";
      args = ["install", "--frozen-lockfile"];
    } else if (existsSync(join(dir, "pnpm-lock.yaml"))) {
      cmd = "pnpm";
      args = ["install", "--frozen-lockfile"];
    } else if (existsSync(join(dir, "yarn.lock"))) {
      cmd = "yarn";
      args = ["install", "--frozen-lockfile"];
    } else {
      cmd = "npm";
      args = ["ci"];
    }
    console.log(`[worktree] Installing JS dependencies with ${cmd} in ${dir}`);
    await exec(cmd, args, { cwd: dir, timeout: 120_000 });
  }

  // Python dependencies
  if (existsSync(join(dir, "pyproject.toml"))) {
    console.log(`[worktree] Installing Python dependencies with uv in ${dir}`);
    await exec("uv", ["sync"], { cwd: dir, timeout: 120_000 });
  }
}

async function run(cmd: string, args: string[], cwd: string) {
  const { stdout, stderr } = await exec(cmd, args, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL ?? "",
    },
    timeout: 60_000,
  });
  if (stderr) return `${stdout}\n${stderr}`.trim();
  return stdout.trim();
}

export const gitCreateWorktree = tool(
  "git_create_worktree",
  "Create a git worktree for development. Creates a new branch from baseBranch, or checks out an existing remote branch if it already exists (e.g. for returning review tickets).",
  {
    repoDir: z.string().describe("Path to the cloned repo, e.g. '/data/repos/paddock-app'"),
    branch: z.string().describe("Branch name, e.g. 'agent/FOO-123'"),
    baseBranch: z.string().default("main").describe("Base branch to fork from (ignored if branch already exists on remote)"),
  },
  async ({ repoDir, branch, baseBranch }) => {
    const worktreeDir = `/data/worktrees/${branch}`;

    // Fetch everything so we can detect if the branch exists
    await run("git", ["fetch", "origin"], repoDir);

    // Check if branch already exists on remote
    let branchExists = false;
    try {
      await run("git", ["rev-parse", "--verify", `origin/${branch}`], repoDir);
      branchExists = true;
    } catch {
      // Branch doesn't exist on remote — will create new
    }

    if (branchExists) {
      // Checkout existing branch (returning from review)
      await run("git", ["worktree", "add", worktreeDir, `origin/${branch}`], repoDir);
      // Ensure local branch tracks remote
      await run("git", ["checkout", "-B", branch, `origin/${branch}`], worktreeDir);
    } else {
      // Create new branch from base
      await run("git", ["worktree", "add", "-b", branch, worktreeDir, `origin/${baseBranch}`], repoDir);
    }

    await installDeps(worktreeDir);
    return {
      content: [{
        type: "text" as const,
        text: branchExists
          ? `Worktree created at ${worktreeDir} on existing branch ${branch} (dependencies installed)`
          : `Worktree created at ${worktreeDir} on new branch ${branch} from ${baseBranch} (dependencies installed)`,
      }],
    };
  },
);

export const gitPushBranch = tool(
  "git_push_branch",
  "Push a branch to the remote origin.",
  {
    branch: z.string().describe("Branch name to push"),
  },
  async ({ branch }) => {
    const worktreeDir = `/data/worktrees/${branch}`;
    const result = await run("git", ["push", "origin", branch], worktreeDir);
    return { content: [{ type: "text" as const, text: result || "Pushed successfully" }] };
  },
);

export const ghCreatePR = tool(
  "gh_create_pr",
  "Create a GitHub pull request using the gh CLI.",
  {
    repo: z.string().describe("GitHub repo identifier, e.g. 'owner/repo'"),
    title: z.string().describe("PR title"),
    body: z.string().describe("PR body in markdown"),
    head: z.string().describe("Head branch name"),
    base: z.string().default("main").describe("Base branch name"),
  },
  async ({ repo, title, body, head, base }) => {
    const worktreeDir = `/data/worktrees/${head}`;
    const result = await run("gh", ["pr", "create", "--title", title, "--body", body, "--base", base, "--head", head, "--repo", repo], worktreeDir);
    return { content: [{ type: "text" as const, text: result }] };
  },
);

export const gitCleanupWorktree = tool(
  "git_cleanup_worktree",
  "Remove a git worktree after work is complete.",
  {
    repoDir: z.string().describe("Path to the cloned repo, e.g. '/data/repos/paddock-app'"),
    branch: z.string().describe("Branch name whose worktree to remove"),
  },
  async ({ repoDir, branch }) => {
    const worktreeDir = `/data/worktrees/${branch}`;
    await run("git", ["worktree", "remove", worktreeDir], repoDir);
    return { content: [{ type: "text" as const, text: `Worktree removed for ${branch}` }] };
  },
);

export const reindexRepo = tool(
  "reindex_repo",
  "Trigger re-indexing of a repository in the vector search database. Use after pushing significant changes so codebase_search returns up-to-date results. When branch is provided, only indexes files changed vs main (much faster).",
  {
    repoDir: z.string().describe("Path to the repo directory, e.g. '/data/repos/paddock-app'"),
    repoName: z.string().describe("Repository name, e.g. 'paddock-app'"),
    branch: z.string().optional().describe("Branch name to diff against main. When provided, only changed files are re-indexed."),
  },
  async ({ repoDir, repoName, branch }) => {
    try {
      const { indexRepo } = await import("../lib/indexer.js");

      let changedFiles: string[] | undefined;
      if (branch) {
        // Get list of changed files vs main
        try {
          const { stdout } = await exec("git", ["diff", "--name-only", "origin/main...HEAD"], {
            cwd: repoDir.startsWith("/data/worktrees/") ? repoDir : repoDir,
            timeout: 30_000,
          });
          changedFiles = stdout.trim().split("\n").filter(Boolean);
          console.log(`[reindex] Found ${changedFiles.length} changed files on branch ${branch}`);
        } catch {
          // Fallback to full reindex if git diff fails
          console.warn(`[reindex] git diff failed, falling back to full reindex`);
        }
      }

      const { indexed, skipped, total } = await indexRepo(repoDir, repoName, changedFiles);
      const mode = changedFiles ? `incremental (${changedFiles.length} files from diff)` : "full";
      return {
        content: [{
          type: "text" as const,
          text: `Re-indexed ${repoName} [${mode}]: ${indexed} chunks from ${total - skipped} changed files (${skipped} unchanged)`,
        }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `Re-index failed (Qdrant may not be available): ${msg}` }] };
    }
  },
);

export const ghPrReview = tool(
  "gh_pr_review",
  "Approve or request changes on a GitHub pull request.",
  {
    repo: z.string().describe("GitHub repo identifier, e.g. 'owner/repo'"),
    prNumber: z.number().describe("PR number"),
    action: z.enum(["approve", "request-changes"]).describe("Review action"),
    body: z.string().describe("Review comment body in markdown"),
  },
  async ({ repo, prNumber, action, body }) => {
    const flag = action === "approve" ? "--approve" : "--request-changes";
    const result = await run("gh", ["pr", "review", String(prNumber), flag, "--body", body, "--repo", repo], "/tmp");
    return { content: [{ type: "text" as const, text: result || `PR #${prNumber} reviewed (${action})` }] };
  },
);
