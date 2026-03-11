/**
 * Worktree cleanup — remove stale worktrees on startup and after errors.
 */

import { readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const WORKTREES_DIR = "/data/worktrees";

/**
 * Clean up all worktrees on startup.
 * If a pod crashed, worktrees are left dangling. Remove them.
 */
export async function cleanupStaleWorktrees(): Promise<void> {
  if (!existsSync(WORKTREES_DIR)) return;

  try {
    const entries = await readdir(WORKTREES_DIR, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory());

    if (dirs.length === 0) return;

    console.log(`[cleanup] Found ${dirs.length} stale worktree(s), cleaning up...`);

    for (const dir of dirs) {
      const worktreePath = `${WORKTREES_DIR}/${dir.name}`;
      try {
        // Try git worktree remove first (clean removal)
        // Find the parent repo by checking .git file in the worktree
        await rm(worktreePath, { recursive: true, force: true });
        console.log(`[cleanup] Removed stale worktree: ${worktreePath}`);
      } catch (err) {
        console.warn(`[cleanup] Failed to remove ${worktreePath}:`, err instanceof Error ? err.message : String(err));
      }
    }

    // Also prune worktree references from all repos
    const REPOS_DIR = "/data/repos";
    if (existsSync(REPOS_DIR)) {
      const repos = await readdir(REPOS_DIR, { withFileTypes: true });
      for (const repo of repos.filter((r) => r.isDirectory())) {
        try {
          await exec("git", ["worktree", "prune"], { cwd: `${REPOS_DIR}/${repo.name}`, timeout: 10_000 });
        } catch {
          // Non-critical
        }
      }
    }
  } catch (err) {
    console.warn(`[cleanup] Worktree cleanup error:`, err instanceof Error ? err.message : String(err));
  }
}

/**
 * Clean up a specific worktree for a branch.
 */
export async function cleanupWorktree(branch: string): Promise<void> {
  const worktreePath = `${WORKTREES_DIR}/${branch}`;
  if (!existsSync(worktreePath)) return;

  try {
    await rm(worktreePath, { recursive: true, force: true });
    console.log(`[cleanup] Removed worktree for ${branch}`);
  } catch (err) {
    console.warn(`[cleanup] Failed to remove worktree for ${branch}:`, err instanceof Error ? err.message : String(err));
  }
}
