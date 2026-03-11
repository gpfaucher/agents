import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const QDRANT_URL = process.env.QDRANT_URL ?? "http://qdrant.agents.svc.cluster.local:6333";
const EMBEDDING_URL =
  process.env.EMBEDDING_URL ?? "http://embeddings.agents.svc.cluster.local:8080/embed";
const COLLECTION = "codebase";

async function getEmbedding(text: string): Promise<number[]> {
  const res = await fetch(EMBEDDING_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    throw new Error(`Embedding request failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { embedding: number[] };
  return data.embedding;
}

interface QdrantPayload {
  repo: string;
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
  language: string;
  lastModified: string;
}

interface QdrantSearchResult {
  id: string | number;
  score: number;
  payload: QdrantPayload;
}

async function searchQdrant(
  vector: number[],
  limit: number,
  filter?: Record<string, unknown>,
): Promise<QdrantSearchResult[]> {
  const body: Record<string, unknown> = {
    vector,
    limit,
    with_payload: true,
  };
  if (filter) body.filter = filter;

  const res = await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Qdrant search failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { result: QdrantSearchResult[] };
  return data.result;
}

function buildFilter(repo?: string, filePattern?: string): Record<string, unknown> | undefined {
  const must: Record<string, unknown>[] = [];

  if (repo) {
    must.push({ key: "repo", match: { value: repo } });
  }

  if (filePattern) {
    // Convert glob-style pattern to a simple substring/prefix match.
    // Qdrant doesn't support globs natively, so we extract the extension
    // or use a substring match on the file path.
    const cleaned = filePattern.replace(/^\*+/, "");
    if (cleaned) {
      must.push({ key: "filePath", match: { text: cleaned } });
    }
  }

  if (must.length === 0) return undefined;
  return { must };
}

function formatResults(results: QdrantSearchResult[]): string {
  if (results.length === 0) {
    return "No results found.";
  }

  return results
    .map((r, i) => {
      const p = r.payload;
      return [
        `### ${i + 1}. ${p.filePath} (L${p.startLine}-${p.endLine}) [score: ${r.score.toFixed(3)}]`,
        `Repo: ${p.repo} | Language: ${p.language}`,
        "```" + p.language,
        p.content,
        "```",
      ].join("\n");
    })
    .join("\n\n");
}

export const codebaseSearch = tool(
  "codebase_search",
  "Semantic search across the indexed codebase. Use natural language queries to find relevant code, functions, or patterns.",
  {
    query: z.string().describe("Natural language search query, e.g. 'authentication middleware' or 'database connection pool'"),
    repo: z.string().optional().describe("Repository name to filter results, e.g. 'paddock-app'"),
    filePattern: z.string().optional().describe("Glob-style file pattern to filter, e.g. '*.ts' or '*.py'"),
    limit: z.number().default(10).describe("Maximum number of results to return"),
  },
  async ({ query, repo, filePattern, limit }) => {
    try {
      const vector = await getEmbedding(query);
      const filter = buildFilter(repo, filePattern);
      const results = await searchQdrant(vector, limit, filter);
      const text = formatResults(results);
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[vector-search] codebase_search failed: ${msg}`);
      return { content: [{ type: "text" as const, text: `Search unavailable: ${msg}` }] };
    }
  },
);

export const codebaseSearchSimilar = tool(
  "codebase_search_similar",
  "Find code similar to a given snippet. Useful for finding duplicate logic, related implementations, or usage examples.",
  {
    code: z.string().describe("Code snippet to find similar code for"),
    repo: z.string().optional().describe("Repository name to filter results, e.g. 'paddock-app'"),
    limit: z.number().default(5).describe("Maximum number of results to return"),
  },
  async ({ code, repo, limit }) => {
    try {
      const vector = await getEmbedding(code);
      const filter = buildFilter(repo);
      const results = await searchQdrant(vector, limit, filter);
      const text = formatResults(results);
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[vector-search] codebase_search_similar failed: ${msg}`);
      return { content: [{ type: "text" as const, text: `Search unavailable: ${msg}` }] };
    }
  },
);
