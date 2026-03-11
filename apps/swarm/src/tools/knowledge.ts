/**
 * Knowledge store — persistent cross-run memory backed by Qdrant.
 *
 * Agents store learnings (patterns, solutions, gotchas, debugging insights)
 * and future runs search them to avoid repeating mistakes and reuse solutions.
 */

import { tool } from "@anthropic-ai/claude-agent-sdk";
import { createHash } from "node:crypto";
import { z } from "zod";

const QDRANT_URL = process.env.QDRANT_URL ?? "http://qdrant.agents.svc.cluster.local:6333";
const EMBEDDING_URL =
  process.env.EMBEDDING_URL ?? "http://embeddings.agents.svc.cluster.local:8080/embed";
const EMBEDDING_DIM = Number(process.env.EMBEDDING_DIM) || 384;
const COLLECTION = "knowledge";

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

let collectionReady = false;

export async function ensureKnowledgeCollection(): Promise<void> {
  if (collectionReady) return;

  const check = await fetch(`${QDRANT_URL}/collections/${COLLECTION}`);
  if (check.ok) {
    collectionReady = true;
    return;
  }

  const res = await fetch(`${QDRANT_URL}/collections/${COLLECTION}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      vectors: { size: EMBEDDING_DIM, distance: "Cosine" },
    }),
  });
  if (!res.ok) {
    throw new Error(`Failed to create knowledge collection: ${res.status} ${await res.text()}`);
  }

  // Create payload indexes for filtering
  for (const field of ["repo", "category", "agent", "issueIdentifier"]) {
    await fetch(`${QDRANT_URL}/collections/${COLLECTION}/index`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ field_name: field, field_schema: "keyword" }),
    });
  }

  collectionReady = true;
  console.log(`[knowledge] Created Qdrant collection '${COLLECTION}'`);
}

function knowledgeId(content: string): string {
  const hash = createHash("sha256").update(content).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

export const knowledgeStore = tool(
  "knowledge_store",
  "Save a useful finding, pattern, solution, or gotcha to the shared knowledge base. Future agent runs will search this. Be specific and actionable.",
  {
    content: z.string().describe("The knowledge to store. Be specific: what the problem was, what the solution was, which files/functions were involved."),
    category: z.enum([
      "pattern",       // Recurring code patterns, conventions, how things are done
      "solution",      // How a specific problem was solved
      "gotcha",        // Non-obvious pitfalls, things that break unexpectedly
      "architecture",  // How systems connect, data flows, key abstractions
      "debugging",     // Debugging insights, common failure modes
      "review",        // Review feedback patterns (things reviewers commonly flag)
    ]).describe("Category of knowledge"),
    repo: z.string().optional().describe("Repository this knowledge applies to"),
    issueIdentifier: z.string().optional().describe("Linear issue this came from (e.g. ENG-123)"),
    files: z.array(z.string()).optional().describe("File paths this knowledge relates to"),
  },
  async ({ content, category, repo, issueIdentifier, files }) => {
    try {
      await ensureKnowledgeCollection();
      const vector = await getEmbedding(content);
      const id = knowledgeId(content);

      const payload: Record<string, unknown> = {
        content,
        category,
        createdAt: new Date().toISOString(),
      };
      if (repo) payload.repo = repo;
      if (issueIdentifier) payload.issueIdentifier = issueIdentifier;
      if (files?.length) payload.files = files;

      const res = await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ points: [{ id, vector, payload }] }),
      });
      if (!res.ok) {
        throw new Error(`Qdrant upsert failed: ${res.status} ${await res.text()}`);
      }

      return { content: [{ type: "text" as const, text: `Knowledge stored (${category}): ${content.slice(0, 80)}...` }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[knowledge] Store failed: ${msg}`);
      return { content: [{ type: "text" as const, text: `Failed to store knowledge: ${msg}` }] };
    }
  },
);

export const knowledgeSearch = tool(
  "knowledge_search",
  "Search the shared knowledge base for past learnings, solutions, patterns, and gotchas from previous agent runs. Always search before starting work on a ticket.",
  {
    query: z.string().describe("Natural language query, e.g. 'authentication flow in paddock-app' or 'how to add a new API endpoint'"),
    category: z.enum(["pattern", "solution", "gotcha", "architecture", "debugging", "review"]).optional()
      .describe("Filter by category"),
    repo: z.string().optional().describe("Filter by repository"),
    limit: z.number().default(10).describe("Maximum number of results"),
  },
  async ({ query, category, repo, limit }) => {
    try {
      await ensureKnowledgeCollection();
      const vector = await getEmbedding(query);

      const must: Record<string, unknown>[] = [];
      if (category) must.push({ key: "category", match: { value: category } });
      if (repo) must.push({ key: "repo", match: { value: repo } });

      const body: Record<string, unknown> = {
        vector,
        limit,
        with_payload: true,
      };
      if (must.length > 0) body.filter = { must };

      const res = await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        throw new Error(`Qdrant search failed: ${res.status} ${await res.text()}`);
      }

      const data = (await res.json()) as {
        result: Array<{
          score: number;
          payload: { content: string; category: string; repo?: string; issueIdentifier?: string; files?: string[]; createdAt: string };
        }>;
      };

      if (data.result.length === 0) {
        return { content: [{ type: "text" as const, text: "No relevant knowledge found." }] };
      }

      const text = data.result
        .map((r, i) => {
          const p = r.payload;
          const meta = [
            p.category,
            p.repo && `repo:${p.repo}`,
            p.issueIdentifier,
            p.files?.length && `files: ${p.files.join(", ")}`,
          ].filter(Boolean).join(" | ");

          return `### ${i + 1}. [${r.score.toFixed(3)}] ${meta}\n${p.content}`;
        })
        .join("\n\n");

      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[knowledge] Search failed: ${msg}`);
      return { content: [{ type: "text" as const, text: `Knowledge search unavailable: ${msg}` }] };
    }
  },
);

/**
 * Programmatic knowledge store — used by the poller to auto-save completion summaries.
 * Not an MCP tool, just a plain async function.
 */
export async function knowledgeStoreFromSystem(input: {
  content: string;
  category: string;
  repo?: string;
  issueIdentifier?: string;
  agent?: string;
  files?: string[];
}): Promise<void> {
  await ensureKnowledgeCollection();
  const vector = await getEmbedding(input.content);
  const id = knowledgeId(input.content);

  const payload: Record<string, unknown> = {
    content: input.content,
    category: input.category,
    createdAt: new Date().toISOString(),
  };
  if (input.repo) payload.repo = input.repo;
  if (input.issueIdentifier) payload.issueIdentifier = input.issueIdentifier;
  if (input.agent) payload.agent = input.agent;
  if (input.files?.length) payload.files = input.files;

  const res = await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ points: [{ id, vector, payload }] }),
  });
  if (!res.ok) {
    throw new Error(`Qdrant upsert failed: ${res.status} ${await res.text()}`);
  }
}
