/**
 * Linear webhook server — event-driven triggers for agent processing.
 *
 * Architecture:
 * - Each agent pod runs this HTTP server
 * - Linear sends webhooks to a single ingress URL
 * - The receiving pod checks if the event matches its role
 * - If yes: triggers immediate processing via triggerIssue()
 * - If no: fans out to other agent pods via their K8s services
 *
 * Endpoints:
 * - POST /webhooks/linear — receives Linear webhook events
 * - POST /trigger — internal: trigger immediate issue processing
 * - GET  /health — health check
 * - GET  /status — agent status (active issues, role, uptime)
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHmac } from "node:crypto";
import type { RoleConfig } from "./roles/index.js";
import { triggerIssue, getActiveIssues } from "./poller.js";

const WEBHOOK_PORT = Number(process.env.WEBHOOK_PORT) || 3000;
const startedAt = Date.now();
const LINEAR_WEBHOOK_SECRET = process.env.LINEAR_WEBHOOK_SECRET;

/** In-memory queue for chat messages from the dashboard, keyed by runKey */
const pendingMessages = new Map<string, string[]>();

/** Get and clear pending messages for a runKey (called by agent.ts via check_human_messages tool) */
export function getPendingMessages(runKey: string): string[] {
  const msgs = pendingMessages.get(runKey) ?? [];
  if (msgs.length > 0) {
    pendingMessages.delete(runKey);
  }
  return msgs;
}

/**
 * Parse AGENT_ENDPOINTS env var for fan-out routing.
 * Format: "pm=http://agent-architect:3000,engineer=http://agent-builder:3000,..."
 */
function parseAgentEndpoints(): Map<string, string> {
  const raw = process.env.AGENT_ENDPOINTS ?? "";
  const map = new Map<string, string>();
  for (const entry of raw.split(",").filter(Boolean)) {
    const eq = entry.indexOf("=");
    if (eq === -1) continue;
    map.set(entry.slice(0, eq).trim(), entry.slice(eq + 1).trim());
  }
  return map;
}

const agentEndpoints = parseAgentEndpoints();

/**
 * Verify Linear webhook signature using HMAC-SHA256.
 */
function verifySignature(body: string, signature: string | undefined): boolean {
  if (!LINEAR_WEBHOOK_SECRET) {
    console.warn("[webhook] LINEAR_WEBHOOK_SECRET not set, skipping signature verification");
    return true;
  }
  if (!signature) return false;

  const hmac = createHmac("sha256", LINEAR_WEBHOOK_SECRET);
  hmac.update(body);
  const expected = hmac.digest("hex");
  return signature === expected;
}

/**
 * Read the request body as a string.
 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

/**
 * Fan out a trigger to other agent pods via their /trigger endpoint.
 */
async function fanOutTrigger(issueId: string, issueIdentifier: string, excludeRole?: string): Promise<void> {
  for (const [role, endpoint] of agentEndpoints) {
    if (role === excludeRole) continue;
    try {
      const res = await fetch(`${endpoint}/trigger`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issueId, issueIdentifier }),
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const data = await res.json() as { picked_up?: boolean };
        if (data.picked_up) {
          console.log(`[webhook] Fan-out: ${role} picked up ${issueIdentifier}`);
          return; // One pod handled it, stop fan-out
        }
      }
    } catch {
      // Pod unreachable — normal during deployments
    }
  }
}

/**
 * Handle a Linear webhook event.
 */
async function handleLinearEvent(role: RoleConfig, payload: Record<string, unknown>): Promise<void> {
  const action = payload.action as string;
  const type = payload.type as string;
  const data = payload.data as Record<string, unknown> | undefined;

  if (!data) {
    console.log(`[webhook] Ignoring event: no data (type=${type}, action=${action})`);
    return;
  }

  // Issue state changes
  if (type === "Issue" && action === "update") {
    const issueId = data.id as string;
    const identifier = data.identifier as string;
    const updatedFrom = payload.updatedFrom as Record<string, unknown> | undefined;

    // Check if state changed
    if (updatedFrom?.stateId) {
      console.log(`[webhook] Issue ${identifier} state changed`);

      // Try to handle locally first
      const handled = await triggerIssue(role, issueId, identifier);
      if (!handled) {
        // Fan out to other agents
        await fanOutTrigger(issueId, identifier, role.name);
      }
    }
    return;
  }

  // Comment created — might be a user responding to an on-hold ticket
  if (type === "Comment" && action === "create") {
    const issueData = data.issue as Record<string, unknown> | undefined;
    if (!issueData) return;

    const issueId = issueData.id as string;
    const identifier = issueData.identifier as string;

    // Only process if it's a user comment (not a bot/system comment)
    const userId = data.userId as string | undefined;
    const botActor = (payload as any).actor?.type === "application";
    if (botActor) {
      console.log(`[webhook] Ignoring bot comment on ${identifier}`);
      return;
    }

    console.log(`[webhook] User comment on ${identifier}, triggering check`);
    const handled = await triggerIssue(role, issueId, identifier);
    if (!handled) {
      await fanOutTrigger(issueId, identifier, role.name);
    }
    return;
  }

  // Ignore other event types
}

/**
 * Start the webhook HTTP server.
 */
export function startWebhookServer(role: RoleConfig): void {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Health check
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }

    // Status endpoint — returns agent state for the dashboard
    if (req.method === "GET" && req.url === "/status") {
      const active = getActiveIssues();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        role: role.name,
        displayName: role.displayName,
        model: role.model,
        uptime: Math.round((Date.now() - startedAt) / 1000),
        activeIssues: active,
        maxConcurrent: Number(process.env.MAX_CONCURRENT) || 1,
      }));
      return;
    }

    // Chat messages endpoint — receives messages from dashboard for agents
    if (req.method === "POST" && req.url?.startsWith("/messages/")) {
      try {
        const runKey = req.url.slice("/messages/".length);
        const body = await readBody(req);
        const data = JSON.parse(body) as { content: string };
        if (data.content) {
          const queue = pendingMessages.get(runKey) ?? [];
          queue.push(data.content);
          pendingMessages.set(runKey, queue);
          console.log(`[webhook] Queued chat message for ${runKey}: ${data.content.slice(0, 100)}`);
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ queued: true }));
      } catch (err) {
        console.error("[webhook] Messages error:", err);
        res.writeHead(400);
        res.end("Bad request");
      }
      return;
    }

    // Get pending messages for a runKey
    if (req.method === "GET" && req.url?.startsWith("/messages/")) {
      const runKey = req.url.slice("/messages/".length);
      const msgs = getPendingMessages(runKey);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ messages: msgs }));
      return;
    }

    // Internal trigger endpoint (from fan-out)
    if (req.method === "POST" && req.url === "/trigger") {
      try {
        const body = await readBody(req);
        const data = JSON.parse(body) as { issueId: string; issueIdentifier: string };
        const pickedUp = await triggerIssue(role, data.issueId, data.issueIdentifier);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ picked_up: pickedUp }));
      } catch (err) {
        console.error("[webhook] Trigger error:", err);
        res.writeHead(500);
        res.end("Internal error");
      }
      return;
    }

    // Linear webhook endpoint
    if (req.method === "POST" && (req.url === "/webhooks/linear" || req.url === "/webhook")) {
      try {
        const body = await readBody(req);

        // Verify signature
        const signature = req.headers["linear-signature"] as string | undefined;
        if (!verifySignature(body, signature)) {
          console.warn("[webhook] Invalid signature, rejecting");
          res.writeHead(401);
          res.end("Invalid signature");
          return;
        }

        const payload = JSON.parse(body) as Record<string, unknown>;

        // Linear sends a URL verification request on webhook creation
        if (payload.type === "url_verification") {
          console.log("[webhook] URL verification request received");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ challenge: payload.challenge }));
          return;
        }

        console.log(`[webhook] Received: ${payload.type}.${payload.action} (${(payload.data as any)?.identifier ?? "?"})`);

        // Respond immediately, process async
        res.writeHead(200);
        res.end("ok");

        // Handle the event asynchronously
        handleLinearEvent(role, payload).catch((err) => {
          console.error("[webhook] Event handling error:", err);
        });
      } catch (err) {
        console.error("[webhook] Parse error:", err);
        res.writeHead(400);
        res.end("Bad request");
      }
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  server.listen(WEBHOOK_PORT, "0.0.0.0", () => {
    console.log(`[webhook] Server listening on :${WEBHOOK_PORT}`);
    if (agentEndpoints.size > 0) {
      console.log(`[webhook] Fan-out endpoints: ${[...agentEndpoints.entries()].map(([k, v]) => `${k}→${v}`).join(", ")}`);
    }
  });
}
