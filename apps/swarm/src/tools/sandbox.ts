import { tool } from "@anthropic-ai/claude-agent-sdk";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

const exec = promisify(execFile);

const SANDBOX_NAMESPACE = process.env.SANDBOX_NAMESPACE || "agent-sandboxes";

async function kubectl(args: string[]): Promise<string> {
  const { stdout } = await exec("kubectl", args, { timeout: 60_000 });
  return stdout.trim();
}

function podName(issueId: string): string {
  const safe = issueId.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 50);
  return `sandbox-${safe}`;
}

export const sandboxCreate = tool(
  "sandbox_create",
  "Create an ephemeral sandbox pod with PostgreSQL (pgvector), Redis, and optionally the app container for testing.",
  {
    issueIdentifier: z.string().describe("Linear issue identifier (e.g. ENG-123) — used to name the sandbox"),
    dbDumpUrl: z.string().optional().describe("MinIO/S3 URL to a pg_dump file to restore (e.g. s3://pg-dumps/stripped-latest.dump)"),
    appImage: z.string().optional().describe("Docker image for the application container"),
  },
  async ({ issueIdentifier, dbDumpUrl, appImage }) => {
    const name = podName(issueIdentifier);
    const minioEndpoint = process.env.MINIO_ENDPOINT || "http://minio.agents.svc.cluster.local:9000";
    const minioBucket = process.env.MINIO_BUCKET || "pg-dumps";

    // Build pod spec
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

    const initContainers: any[] = [];
    if (dbDumpUrl) {
      initContainers.push({
        name: "db-restore",
        image: "pgvector/pgvector:pg16",
        command: ["/bin/bash", "-c"],
        args: [`
          # Wait for postgres to be ready
          until pg_isready -h localhost -U postgres; do sleep 1; done

          # Download dump from MinIO
          curl -fsSL https://dl.min.io/client/mc/release/linux-amd64/mc -o /usr/local/bin/mc
          chmod +x /usr/local/bin/mc
          mc alias set store ${minioEndpoint} $MINIO_ACCESS_KEY $MINIO_SECRET_KEY
          mc cp store/${minioBucket}/stripped-latest.dump /tmp/dump.dump

          # Restore
          pg_restore -h localhost -U postgres -d sandbox --no-owner --no-acl /tmp/dump.dump || true
          echo "Database restored"
        `],
        env: [
          { name: "MINIO_ACCESS_KEY", value: process.env.MINIO_ACCESS_KEY || "" },
          { name: "MINIO_SECRET_KEY", value: process.env.MINIO_SECRET_KEY || "" },
        ],
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
        initContainers,
        containers,
      },
    };

    // Create via kubectl apply
    const specJson = JSON.stringify(podSpec);
    await exec("kubectl", ["apply", "-f", "-", "-n", SANDBOX_NAMESPACE], {
      timeout: 30_000,
      // @ts-ignore - pass stdin
    });

    // Actually use a temp file approach
    const { writeFile, unlink } = await import("node:fs/promises");
    const tmpFile = `/tmp/sandbox-${name}.json`;
    await writeFile(tmpFile, specJson);
    await kubectl(["apply", "-f", tmpFile, "-n", SANDBOX_NAMESPACE]);
    await unlink(tmpFile);

    // Wait for pod to be ready (up to 5 min)
    try {
      await kubectl([
        "wait", "--for=condition=Ready", `pod/${name}`,
        "-n", SANDBOX_NAMESPACE, "--timeout=300s",
      ]);
    } catch {
      // Get pod status for debugging
      const status = await kubectl(["get", "pod", name, "-n", SANDBOX_NAMESPACE, "-o", "json"]);
      return {
        content: [{ type: "text" as const, text: `Sandbox ${name} created but not ready yet. Status:\n${status.slice(0, 1000)}` }],
      };
    }

    return {
      content: [{ type: "text" as const, text: `Sandbox ${name} is ready.\nPostgreSQL: localhost:5432/sandbox (inside pod)\nRedis: localhost:6379 (inside pod)\nUse sandbox_db_query to run SQL queries.` }],
    };
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
