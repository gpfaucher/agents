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

export const triggerImport = tool(
  "trigger_import",
  "Trigger a data import in the sandbox app container. Runs the import worker for a specific system or all systems.",
  {
    issueIdentifier: z.string().describe("Linear issue identifier of the sandbox"),
    command: z.string().default("python -m app.modules.data_import.cli --run-once").describe("Import command to execute in the app container"),
  },
  async ({ issueIdentifier, command }) => {
    const name = podName(issueIdentifier);

    try {
      const { stdout, stderr } = await exec(
        "kubectl",
        [
          "exec", name, "-n", SANDBOX_NAMESPACE, "-c", "app",
          "--", "bash", "-c", command,
        ],
        { timeout: 300_000 }, // 5 minute timeout for imports
      );

      const output = (stdout + (stderr ? `\nstderr: ${stderr}` : "")).trim();
      const truncated = output.length > 5000 ? output.slice(0, 5000) + "\n... (truncated)" : output;
      return { content: [{ type: "text" as const, text: `Import triggered:\n${truncated}` }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `Import failed: ${msg}` }] };
    }
  },
);

export const waitImportComplete = tool(
  "wait_import_complete",
  "Wait for an import to complete by checking the import status in the sandbox database.",
  {
    issueIdentifier: z.string().describe("Linear issue identifier of the sandbox"),
    timeoutSeconds: z.number().default(120).describe("Maximum seconds to wait"),
  },
  async ({ issueIdentifier, timeoutSeconds }) => {
    const name = podName(issueIdentifier);
    const startTime = Date.now();

    while ((Date.now() - startTime) < timeoutSeconds * 1000) {
      try {
        const { stdout } = await exec(
          "kubectl",
          [
            "exec", name, "-n", SANDBOX_NAMESPACE, "-c", "postgres",
            "--", "psql", "-U", "postgres", "-d", "sandbox", "-t", "-A", "-c",
            "SELECT status, error_message FROM import_jobs ORDER BY created_at DESC LIMIT 1;",
          ],
          { timeout: 10_000 },
        );

        const result = stdout.trim();
        if (result.includes("completed") || result.includes("failed")) {
          return { content: [{ type: "text" as const, text: `Import status: ${result}` }] };
        }
      } catch {
        // Table might not exist yet, keep waiting
      }

      await new Promise((r) => setTimeout(r, 5000));
    }

    return { content: [{ type: "text" as const, text: `Import did not complete within ${timeoutSeconds}s` }] };
  },
);
