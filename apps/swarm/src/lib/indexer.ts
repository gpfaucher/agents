/**
 * Codebase indexer — walks repo files, chunks them semantically, embeds, and upserts to Qdrant.
 * Features:
 * - Incremental: tracks file content hashes, only re-indexes changed files
 * - Semantic chunking: splits at function/class boundaries instead of fixed line counts
 * - On-demand: exports indexRepo() for triggering after pushes
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, extname, relative } from "node:path";
import { createHash } from "node:crypto";

const QDRANT_URL = process.env.QDRANT_URL ?? "http://qdrant.agents.svc.cluster.local:6333";
const EMBEDDING_URL =
  process.env.EMBEDDING_URL ?? "http://embeddings.agents.svc.cluster.local:8080/embed";
const EMBEDDING_DIM = Number(process.env.EMBEDDING_DIM) || 384;
const COLLECTION = "codebase";
const MAX_CHUNK_LINES = 120;
const MIN_CHUNK_LINES = 10;
const REINDEX_INTERVAL_MS = 10 * 60 * 1000;
const BATCH_SIZE = 32;

const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".sql", ".md",
  ".json", ".yaml", ".yml", ".toml", ".css", ".scss", ".html", ".svelte", ".vue",
]);

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "__pycache__", ".next",
  "coverage", ".turbo", ".cache", ".output", "vendor",
]);

const SKIP_PATTERNS = [/\.min\.js$/, /\.lock$/, /\.map$/, /\.d\.ts$/];

function shouldIndex(filePath: string): boolean {
  const ext = extname(filePath);
  if (!SOURCE_EXTENSIONS.has(ext)) return false;
  if (SKIP_PATTERNS.some((p) => p.test(filePath))) return false;
  return true;
}

function langFromExt(ext: string): string {
  const map: Record<string, string> = {
    ".ts": "typescript", ".tsx": "typescript", ".js": "javascript", ".jsx": "javascript",
    ".py": "python", ".go": "go", ".sql": "sql", ".md": "markdown",
    ".json": "json", ".yaml": "yaml", ".yml": "yaml", ".toml": "toml",
    ".css": "css", ".scss": "scss", ".html": "html", ".svelte": "svelte", ".vue": "vue",
  };
  return map[ext] ?? "text";
}

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function pointId(repo: string, filePath: string, startLine: number): string {
  const hash = createHash("sha256")
    .update(`${repo}:${filePath}:${startLine}`)
    .digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

/** Track file hashes to skip unchanged files. Map<"repo:path", hash> */
const fileHashes = new Map<string, string>();

// ─── Semantic chunking ───────────────────────────────────────────────

/**
 * Boundary patterns for splitting code at semantic points.
 * These detect the START of a new logical block.
 */
const BOUNDARY_PATTERNS: Record<string, RegExp[]> = {
  typescript: [
    /^(?:export\s+)?(?:async\s+)?function\s+\w/,                // function declarations
    /^(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?\(/,  // arrow functions
    /^(?:export\s+)?(?:abstract\s+)?class\s+\w/,                // class declarations
    /^(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?function/,  // function expressions
    /^(?:export\s+)?interface\s+\w/,                             // interfaces
    /^(?:export\s+)?type\s+\w+\s*=/,                             // type aliases
    /^(?:export\s+)?enum\s+\w/,                                  // enums
    /^\s+(?:async\s+)?(?:get\s+|set\s+)?\w+\s*\(/,              // class methods
    /^describe\s*\(/,                                            // test suites
    /^it\s*\(/,                                                  // test cases
    /^test\s*\(/,                                                // test cases
  ],
  javascript: [], // filled below
  python: [
    /^(?:async\s+)?def\s+\w/,
    /^class\s+\w/,
    /^@\w+/,  // decorators (usually before a function/class)
  ],
  go: [
    /^func\s+/,
    /^type\s+\w+\s+struct/,
    /^type\s+\w+\s+interface/,
  ],
  sql: [
    /^CREATE\s+/i,
    /^ALTER\s+/i,
    /^INSERT\s+/i,
    /^SELECT\s+/i,
    /^--\s*migration/i,
  ],
  markdown: [
    /^#{1,3}\s+/,  // headings
  ],
};
// JS uses same patterns as TS
BOUNDARY_PATTERNS.javascript = BOUNDARY_PATTERNS.typescript;

function isBoundary(line: string, language: string): boolean {
  const patterns = BOUNDARY_PATTERNS[language];
  if (!patterns) return false;
  return patterns.some((p) => p.test(line));
}

interface Chunk {
  id: string;
  content: string;
  payload: {
    repo: string;
    filePath: string;
    startLine: number;
    endLine: number;
    language: string;
    lastModified: string;
    contentHash: string;
  };
}

function chunkFile(
  content: string,
  repo: string,
  filePath: string,
  lastModified: string,
): Chunk[] {
  const lines = content.split("\n");
  const language = langFromExt(extname(filePath));
  const hash = contentHash(content);
  const chunks: Chunk[] = [];

  // Small files get a single chunk
  if (lines.length <= MAX_CHUNK_LINES) {
    chunks.push({
      id: pointId(repo, filePath, 1),
      content,
      payload: { repo, filePath, startLine: 1, endLine: lines.length, language, lastModified, contentHash: hash },
    });
    return chunks;
  }

  // Semantic chunking: split at function/class boundaries
  let chunkStart = 0;

  for (let i = 1; i < lines.length; i++) {
    const currentChunkSize = i - chunkStart;
    const line = lines[i];

    // Check if this line is a semantic boundary AND the current chunk is big enough
    const atBoundary = isBoundary(line, language);
    const chunkTooBig = currentChunkSize >= MAX_CHUNK_LINES;
    const chunkBigEnough = currentChunkSize >= MIN_CHUNK_LINES;

    if ((atBoundary && chunkBigEnough) || chunkTooBig) {
      const chunkContent = lines.slice(chunkStart, i).join("\n");
      if (chunkContent.trim().length > 0) {
        chunks.push({
          id: pointId(repo, filePath, chunkStart + 1),
          content: chunkContent,
          payload: {
            repo, filePath,
            startLine: chunkStart + 1, endLine: i,
            language, lastModified, contentHash: hash,
          },
        });
      }
      chunkStart = i;
    }
  }

  // Final chunk
  if (chunkStart < lines.length) {
    const chunkContent = lines.slice(chunkStart).join("\n");
    if (chunkContent.trim().length > 0) {
      chunks.push({
        id: pointId(repo, filePath, chunkStart + 1),
        content: chunkContent,
        payload: {
          repo, filePath,
          startLine: chunkStart + 1, endLine: lines.length,
          language, lastModified, contentHash: hash,
        },
      });
    }
  }

  return chunks;
}

// ─── File walking ────────────────────────────────────────────────────

async function walkDir(dir: string, baseDir: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      files.push(...await walkDir(join(dir, entry.name), baseDir));
    } else if (entry.isFile()) {
      const relPath = relative(baseDir, join(dir, entry.name));
      if (shouldIndex(relPath)) {
        files.push(join(dir, entry.name));
      }
    }
  }

  return files;
}

// ─── Embedding & Qdrant ─────────────────────────────────────────────

async function getEmbeddings(texts: string[]): Promise<number[][]> {
  const res = await fetch(EMBEDDING_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ texts }),
  });
  if (!res.ok) {
    throw new Error(`Embedding request failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { embeddings: number[][] };
  return data.embeddings;
}

async function upsertPoints(
  points: Array<{ id: string; vector: number[]; payload: Record<string, unknown> }>,
): Promise<void> {
  const res = await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ points }),
  });
  if (!res.ok) {
    throw new Error(`Qdrant upsert failed: ${res.status} ${await res.text()}`);
  }
}

async function deletePointsByFilter(filter: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filter }),
  });
  if (!res.ok) {
    console.warn(`[indexer] Delete failed: ${res.status}`);
  }
}

async function ensureCollection(): Promise<void> {
  const check = await fetch(`${QDRANT_URL}/collections/${COLLECTION}`);
  if (check.ok) return;

  const res = await fetch(`${QDRANT_URL}/collections/${COLLECTION}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      vectors: { size: EMBEDDING_DIM, distance: "Cosine" },
    }),
  });
  if (!res.ok) {
    throw new Error(`Failed to create collection: ${res.status} ${await res.text()}`);
  }

  // Create payload indexes for filtering
  for (const field of ["repo", "filePath", "contentHash"]) {
    await fetch(`${QDRANT_URL}/collections/${COLLECTION}/index`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ field_name: field, field_schema: "keyword" }),
    });
  }

  console.log(`[indexer] Created Qdrant collection '${COLLECTION}' (dim=${EMBEDDING_DIM})`);
}

// ─── Indexing ────────────────────────────────────────────────────────

/**
 * Index a repository. Incremental: skips files whose content hash hasn't changed.
 * Returns { indexed, skipped, total } counts.
 *
 * @param changedFiles — optional list of relative file paths to index (for targeted reindex).
 *   When provided, only these files are processed instead of walking the entire repo.
 */
export async function indexRepo(
  repoDir: string,
  repoName: string,
  changedFiles?: string[],
): Promise<{ indexed: number; skipped: number; total: number }> {
  let filesToProcess: string[];

  if (changedFiles && changedFiles.length > 0) {
    // Targeted reindex: only process the specified files
    filesToProcess = changedFiles
      .filter((f) => shouldIndex(f))
      .map((f) => join(repoDir, f));
  } else {
    // Full walk
    filesToProcess = await walkDir(repoDir, repoDir);
  }

  const allChunks: Chunk[] = [];
  let skipped = 0;

  for (const filePath of filesToProcess) {
    try {
      const content = await readFile(filePath, "utf-8");
      if (content.length > 500_000) continue; // Skip very large files

      const relPath = relative(repoDir, filePath);
      const hash = contentHash(content);
      const hashKey = `${repoName}:${relPath}`;

      // Skip if unchanged
      if (fileHashes.get(hashKey) === hash) {
        skipped++;
        continue;
      }

      const fileStat = await stat(filePath);
      const chunks = chunkFile(content, repoName, relPath, fileStat.mtime.toISOString());
      allChunks.push(...chunks);

      // Delete old chunks for this file before upserting new ones
      // (file may have changed shape, producing different chunk boundaries)
      await deletePointsByFilter({
        must: [
          { key: "repo", match: { value: repoName } },
          { key: "filePath", match: { value: relPath } },
        ],
      });

      fileHashes.set(hashKey, hash);
    } catch {
      // Skip unreadable files
    }
  }

  // Embed and upsert in batches
  for (let i = 0; i < allChunks.length; i += BATCH_SIZE) {
    const batch = allChunks.slice(i, i + BATCH_SIZE);
    try {
      const embeddings = await getEmbeddings(batch.map((c) => c.content));
      const points = batch.map((chunk, idx) => ({
        id: chunk.id,
        vector: embeddings[idx],
        payload: { ...chunk.payload, content: chunk.content } as Record<string, unknown>,
      }));
      await upsertPoints(points);
    } catch (err) {
      console.warn(
        `[indexer] Batch ${Math.floor(i / BATCH_SIZE) + 1} failed for ${repoName}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return { indexed: allChunks.length, skipped, total: filesToProcess.length };
}

// ─── Startup ─────────────────────────────────────────────────────────

async function waitForEmbeddings(): Promise<void> {
  const healthUrl = EMBEDDING_URL.replace(/\/embed$/, "/health");
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(healthUrl);
      if (res.ok) return;
    } catch {
      // Not ready yet
    }
    console.log(`[indexer] Waiting for embeddings service... (${i + 1}/30)`);
    await new Promise((r) => setTimeout(r, 5_000));
  }
  throw new Error("Embeddings service not available after 150s");
}

export async function startIndexer(repos: Map<string, string>): Promise<void> {
  // Wait for dependencies before starting
  try {
    await waitForEmbeddings();
    await ensureCollection();

    // Also ensure the knowledge collection exists (shared across all agents)
    const { ensureKnowledgeCollection } = await import("../tools/knowledge.js");
    await ensureKnowledgeCollection();
  } catch (err) {
    console.warn(
      `[indexer] Could not connect to dependencies, indexing disabled:`,
      err instanceof Error ? err.message : String(err),
    );
    return;
  }

  // Initial full index
  console.log(`[indexer] Starting initial index of ${repos.size} repo(s)`);
  for (const [name, dir] of repos) {
    try {
      const { indexed, skipped, total } = await indexRepo(dir, name);
      console.log(`[indexer] Indexed ${name}: ${indexed} chunks from ${total - skipped} changed files (${skipped} unchanged)`);
    } catch (err) {
      console.warn(
        `[indexer] Failed to index ${name}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  console.log(`[indexer] Initial indexing complete`);

  // Periodic incremental re-index
  setInterval(async () => {
    for (const [name, dir] of repos) {
      try {
        const { indexed, skipped, total } = await indexRepo(dir, name);
        if (indexed > 0) {
          console.log(`[indexer] Re-indexed ${name}: ${indexed} chunks from ${total - skipped} changed files (${skipped} unchanged)`);
        }
      } catch (err) {
        console.warn(
          `[indexer] Re-index failed for ${name}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }, REINDEX_INTERVAL_MS);
}
