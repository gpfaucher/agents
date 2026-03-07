import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);

const REPOS_DIR = "/data/repos";

export interface RepoContext {
  githubRepo: string; // e.g. "Pontifexx-Tech/paddock-app"
  repoName: string; // e.g. "paddock-app"
  repoDir: string; // e.g. "/data/repos/paddock-app"
}

/**
 * Parse REPO_MAP env var: "paddock-app=Pontifexx-Tech/paddock-app,pfx-planning=Pontifexx-Tech/pfx-planning"
 * Keys are matched against Linear issue labels prefixed with "repo:" (e.g. label "repo:paddock-app").
 */
function parseRepoMap(): Map<string, string> {
  const raw = process.env.REPO_MAP ?? "";
  const map = new Map<string, string>();
  for (const entry of raw.split(",").filter(Boolean)) {
    const eq = entry.indexOf("=");
    if (eq === -1) continue;
    const key = entry.slice(0, eq).trim();
    const value = entry.slice(eq + 1).trim();
    if (key && value) map.set(key, value);
  }
  return map;
}

const repoMap = parseRepoMap();

/**
 * Resolve a repo from an issue's labels.
 * Looks for a label matching "repo:<name>" where <name> is a key in REPO_MAP.
 */
export function getRepoForIssue(labels: string[]): RepoContext | null {
  for (const label of labels) {
    if (!label.startsWith("repo:")) continue;
    const name = label.slice("repo:".length);
    const githubRepo = repoMap.get(name);
    if (githubRepo) {
      const repoName = githubRepo.split("/").pop()!;
      return { githubRepo, repoName, repoDir: `${REPOS_DIR}/${repoName}` };
    }
  }
  return null;
}

/** Clone or fetch a repo. Returns the repo directory path. */
export async function ensureRepoCloned(ctx: RepoContext): Promise<string> {
  await mkdir(REPOS_DIR, { recursive: true });

  const ghToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const cloneUrl = ghToken
    ? `https://${ghToken}@github.com/${ctx.githubRepo}.git`
    : `https://github.com/${ctx.githubRepo}.git`;

  if (existsSync(`${ctx.repoDir}/.git`)) {
    console.log(`[repos] Fetching latest for ${ctx.repoName}`);
    await exec("git", ["fetch", "origin"], {
      cwd: ctx.repoDir,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL ?? "",
      },
      timeout: 120_000,
    });
    await exec("git", ["pull", "--ff-only"], {
      cwd: ctx.repoDir,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL ?? "",
      },
      timeout: 30_000,
    }).catch(() => {
      // pull may fail on detached HEAD or diverged branches — fetch is enough
    });
  } else {
    console.log(`[repos] Cloning ${ctx.githubRepo} into ${ctx.repoDir}`);
    await exec("git", ["clone", cloneUrl, ctx.repoDir], {
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL ?? "",
      },
      timeout: 300_000,
    });
    // Set git config in the cloned repo
    await exec("git", ["config", "user.name", "agent"], { cwd: ctx.repoDir });
    await exec("git", ["config", "user.email", "agent@noreply"], { cwd: ctx.repoDir });
  }

  return ctx.repoDir;
}

/** Log the configured repo mappings at startup. */
export function logRepoMap(): void {
  if (repoMap.size === 0) {
    console.warn("[repos] REPO_MAP not set — no label→repo mappings configured");
    return;
  }
  console.log(`[repos] Label→repo mappings:`);
  for (const [name, repo] of repoMap) {
    console.log(`  repo:${name} → ${repo}`);
  }
}
