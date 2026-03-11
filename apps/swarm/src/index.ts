// Agent Swarm — autonomous multi-agent system
import { loadRole } from "./roles/index.js";
import { initTracing } from "./lib/tracing.js";
import { logRepoMap, parseRepoMap } from "./lib/repos.js";
import { startPoller } from "./poller.js";
import { startIndexer } from "./lib/indexer.js";

const REPOS_DIR = "/data/repos";

async function main() {
  const role = loadRole();
  console.log(`Starting agent: ${role.displayName} (${role.name})`);

  logRepoMap();
  initTracing();

  // Start codebase indexer only on the PM agent (avoid 5 pods indexing the same repos)
  if (process.env.QDRANT_URL && role.name === "pm") {
    const repoMap = parseRepoMap();
    const repoDirs = new Map<string, string>();
    for (const [name, ghRepo] of repoMap) {
      const repoName = ghRepo.split("/").pop()!;
      repoDirs.set(repoName, `${REPOS_DIR}/${repoName}`);
    }
    startIndexer(repoDirs).catch((err) => {
      console.warn("[indexer] Indexer failed to start:", err instanceof Error ? err.message : String(err));
    });
  }

  startPoller(role);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
