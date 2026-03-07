import { tool } from "@anthropic-ai/claude-agent-sdk";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

const exec = promisify(execFile);

const SANDBOX_NAMESPACE = process.env.SANDBOX_NAMESPACE || "agent-sandboxes";

function podName(issueId: string): string {
  const safe = issueId.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 50);
  return `sandbox-${safe}`;
}

export const sandboxDbQuery = tool(
  "sandbox_db_query",
  "Run a SQL query against the PostgreSQL database in a sandbox pod. Use for verifying data, checking migrations, etc.",
  {
    issueIdentifier: z.string().describe("Linear issue identifier of the sandbox"),
    query: z.string().describe("SQL query to execute (SELECT only recommended)"),
    database: z.string().default("sandbox").describe("Database name"),
  },
  async ({ issueIdentifier, query: sqlQuery, database }) => {
    const name = podName(issueIdentifier);

    try {
      const { stdout, stderr } = await exec(
        "kubectl",
        [
          "exec", name, "-n", SANDBOX_NAMESPACE, "-c", "postgres",
          "--", "psql", "-U", "postgres", "-d", database, "-c", sqlQuery,
        ],
        { timeout: 30_000 },
      );

      const output = stdout + (stderr ? `\n${stderr}` : "");
      // Truncate very long results
      const truncated = output.length > 5000 ? output.slice(0, 5000) + "\n... (truncated)" : output;
      return { content: [{ type: "text" as const, text: truncated }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `Query error: ${msg}` }] };
    }
  },
);
