import { tool } from "@anthropic-ai/claude-agent-sdk";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, unlink } from "node:fs/promises";
import { z } from "zod";

const exec = promisify(execFile);

const SANDBOX_NAMESPACE = process.env.SANDBOX_NAMESPACE || "agent-sandboxes";

async function kubectl(args: string[], timeout = 60_000): Promise<string> {
  const { stdout } = await exec("kubectl", args, { timeout });
  return stdout.trim();
}

function podName(issueId: string): string {
  const safe = issueId.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 50);
  return `sandbox-${safe}`;
}

export const sandboxCreate = tool(
  "sandbox_create",
  "Create an ephemeral sandbox pod with PostgreSQL (pgvector), Redis, optionally the app container and a Playwright browser for UI testing.",
  {
    issueIdentifier: z.string().describe("Linear issue identifier (e.g. ENG-123) — used to name the sandbox"),
    dbDumpUrl: z.string().optional().describe("MinIO/S3 URL to a pg_dump file to restore (e.g. s3://pg-dumps/stripped-latest.dump)"),
    appImage: z.string().optional().describe("Docker image for the application container"),
    enableBrowser: z.boolean().optional().describe("Include a Playwright browser sidecar for UI testing (default false)"),
  },
  async ({ issueIdentifier, dbDumpUrl, appImage, enableBrowser }) => {
    const name = podName(issueIdentifier);
    const minioEndpoint = process.env.MINIO_ENDPOINT || "http://minio.agents.svc.cluster.local:9000";

    const containers: any[] = [
      {
        name: "postgres",
        image: "pgvector/pgvector:pg16",
        env: [
          { name: "POSTGRES_HOST_AUTH_METHOD", value: "trust" },
          { name: "POSTGRES_DB", value: "sandbox" },
        ],
        ports: [{ containerPort: 5432 }],
        resources: {
          requests: { cpu: "250m", memory: "512Mi" },
          limits: { cpu: "1", memory: "2Gi" },
        },
        readinessProbe: {
          exec: { command: ["pg_isready", "-U", "postgres"] },
          initialDelaySeconds: 5,
          periodSeconds: 2,
        },
      },
      {
        name: "redis",
        image: "redis:7-alpine",
        ports: [{ containerPort: 6379 }],
        resources: {
          requests: { cpu: "50m", memory: "64Mi" },
          limits: { cpu: "250m", memory: "256Mi" },
        },
      },
    ];

    if (appImage) {
      containers.push({
        name: "app",
        image: appImage,
        env: [
          { name: "DATABASE_URL", value: "postgresql://postgres:postgres@localhost:5432/sandbox" },
          { name: "REDIS_URL", value: "redis://localhost:6379" },
        ],
        ports: [{ containerPort: 8000 }],
        resources: {
          requests: { cpu: "250m", memory: "256Mi" },
          limits: { cpu: "1", memory: "1Gi" },
        },
      });
    }

    if (enableBrowser) {
      containers.push({
        name: "browser",
        image: "mcr.microsoft.com/playwright:v1.50.0-noble",
        command: ["sleep", "infinity"],
        resources: {
          requests: { cpu: "250m", memory: "512Mi" },
          limits: { cpu: "1", memory: "2Gi" },
        },
      });
    }

    const podSpec = {
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name,
        namespace: SANDBOX_NAMESPACE,
        labels: {
          "app.kubernetes.io/managed-by": "agent-swarm",
          "agent.swarm/issue": issueIdentifier,
        },
      },
      spec: {
        restartPolicy: "Never",
        containers,
      },
    };

    // Create pod via temp file
    const specJson = JSON.stringify(podSpec);
    const tmpFile = `/tmp/sandbox-${name}.json`;
    await writeFile(tmpFile, specJson);
    try {
      await kubectl(["apply", "-f", tmpFile, "-n", SANDBOX_NAMESPACE]);
    } finally {
      await unlink(tmpFile).catch(() => {});
    }

    // Wait for pod to be ready (up to 5 min)
    try {
      await kubectl(
        ["wait", "--for=condition=Ready", `pod/${name}`, "-n", SANDBOX_NAMESPACE, "--timeout=300s"],
        310_000,
      );
    } catch {
      const status = await kubectl(["get", "pod", name, "-n", SANDBOX_NAMESPACE, "-o", "json"]);
      return {
        content: [{ type: "text" as const, text: `Sandbox ${name} created but not ready yet. Status:\n${status.slice(0, 1000)}` }],
      };
    }

    // Restore DB dump after postgres is ready
    if (dbDumpUrl) {
      const minioAccessKey = process.env.MINIO_ACCESS_KEY || "minioadmin";
      const minioSecretKey = process.env.MINIO_SECRET_KEY || "minioadmin";
      const restoreScript = [
        `apt-get update -qq && apt-get install -y -qq curl > /dev/null 2>&1`,
        `curl -fsSL https://dl.min.io/client/mc/release/linux-amd64/mc -o /usr/local/bin/mc && chmod +x /usr/local/bin/mc`,
        `mc alias set store ${minioEndpoint} ${minioAccessKey} ${minioSecretKey}`,
        `mc cp store/pg-dumps/stripped-latest.dump /tmp/dump.dump`,
        `pg_restore -h localhost -U postgres -d sandbox --no-owner --no-acl /tmp/dump.dump || true`,
        `rm -f /tmp/dump.dump`,
        `echo "DB_RESTORE_COMPLETE"`,
      ].join(" && ");

      try {
        const restoreResult = await kubectl(
          ["exec", name, "-n", SANDBOX_NAMESPACE, "-c", "postgres", "--", "bash", "-c", restoreScript],
          600_000, // 10 min for large dumps
        );
        const success = restoreResult.includes("DB_RESTORE_COMPLETE");
        if (!success) {
          return {
            content: [{ type: "text" as const, text: `Sandbox ${name} ready but DB restore may have failed:\n${restoreResult.slice(-500)}` }],
          };
        }
      } catch (e: any) {
        return {
          content: [{ type: "text" as const, text: `Sandbox ${name} ready but DB restore failed: ${e.message?.slice(0, 500)}` }],
        };
      }
    }

    const parts = [`Sandbox ${name} is ready.`, `PostgreSQL: localhost:5432/sandbox (inside pod)`, `Redis: localhost:6379 (inside pod)`];
    if (dbDumpUrl) parts.push("Database restored from dump.");
    if (enableBrowser) parts.push("Playwright browser sidecar available.");
    if (appImage) parts.push(`App container running on port 8000.`);
    parts.push("Use sandbox_db_query to run SQL queries.");

    return { content: [{ type: "text" as const, text: parts.join("\n") }] };
  },
);

export const sandboxDestroy = tool(
  "sandbox_destroy",
  "Destroy a sandbox pod and clean up resources.",
  {
    issueIdentifier: z.string().describe("Linear issue identifier used when creating the sandbox"),
  },
  async ({ issueIdentifier }) => {
    const name = podName(issueIdentifier);
    const result = await kubectl(["delete", "pod", name, "-n", SANDBOX_NAMESPACE, "--ignore-not-found"]);
    return { content: [{ type: "text" as const, text: result || `Sandbox ${name} deleted` }] };
  },
);

export const sandboxStatus = tool(
  "sandbox_status",
  "Get the status of a sandbox pod including container states.",
  {
    issueIdentifier: z.string().describe("Linear issue identifier used when creating the sandbox"),
  },
  async ({ issueIdentifier }) => {
    const name = podName(issueIdentifier);
    const result = await kubectl([
      "get", "pod", name, "-n", SANDBOX_NAMESPACE,
      "-o", "jsonpath={.status.phase} | Containers: {range .status.containerStatuses[*]}{.name}={.ready} {end}",
    ]);
    return { content: [{ type: "text" as const, text: result }] };
  },
);
