import {
  query,
  tool,
  createSdkMcpServer,
  type HookCallback,
  type SubagentStopHookInput,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { traceAgent } from "./lib/tracing.js";
import { updateRateLimitState } from "./lib/rate-limiter.js";
import { streamMessage } from "./lib/dashboard-stream.js";
import { getPendingMessages } from "./webhook.js";
import type { RoleConfig } from "./roles/index.js";
import type { RepoContext } from "./lib/repos.js";

export interface AgentResult {
  text: string;
  costUsd: number;
  numTurns: number;
  durationMs: number;
}

export interface StreamContext {
  runKey: string;
  agentRole: string;
  issueIdentifier: string;
}

function formatMessage(message: any): string {
  const base = `[sdk] ${message.type}${
    "subtype" in message ? `:${message.subtype}` : ""
  }`;

  if (message.type === "assistant") {
    const content = message?.message?.content;
    if (!Array.isArray(content)) return base;

    const parts: string[] = [];

    const text = content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("")
      .trim();
    if (text) {
      parts.push(text.length > 200 ? text.slice(0, 200) + "..." : text);
    }

    const tools = content
      .filter((b: any) => b.type === "tool_use")
      .map((b: any) => b.name);
    if (tools.length) {
      parts.push(`tools=[${tools.join(", ")}]`);
    }

    return parts.length ? `${base} | ${parts.join(" | ")}` : base;
  }

  if (message.type === "user") {
    const content = message?.message?.content;
    if (!Array.isArray(content)) return base;

    const toolResults = content.filter((b: any) => b.type === "tool_result");
    if (toolResults.length) {
      return `${base} | ${toolResults.length} tool result(s)`;
    }
    return base;
  }

  return base;
}

// Hook: log MCP tool calls for audit trail
const mcpAuditHook: HookCallback = async (input, _toolUseID, _ctx) => {
  if (input.hook_event_name === "PostToolUse") {
    const postInput = input as any;
    console.log(
      `[audit] ${postInput.tool_name}(${JSON.stringify(postInput.tool_input).slice(0, 150)})`,
    );
  }
  return {};
};

// Hook: log subagent completion
const subagentStopHook: HookCallback = async (input, _toolUseID, _ctx) => {
  const subInput = input as SubagentStopHookInput;
  console.log(
    `[audit] subagent ${subInput.agent_type} completed (id: ${subInput.agent_id})`,
  );
  return {};
};

export async function invokeAgent(
  prompt: string,
  role: RoleConfig,
  repo?: RepoContext,
  streamCtx?: StreamContext,
): Promise<AgentResult> {
  return traceAgent(
    `${role.name}-invoke`,
    prompt,
    { role: role.name, displayName: role.displayName, repo: repo?.githubRepo },
    async () => {
      let resultText = "";
      let costUsd = 0;
      let numTurns = 0;
      let durationMs = 0;

      // Helper to stream messages to dashboard
      const stream = (msgType: string, content: string) => {
        if (streamCtx) {
          streamMessage(streamCtx.runKey, streamCtx.agentRole, streamCtx.issueIdentifier, msgType, content);
        }
      };

      // check_human_messages tool — lets agent read pending chat messages
      const checkHumanMessagesTool = tool(
        "check_human_messages",
        "Check for pending messages from the human operator sent via the dashboard console. Call this periodically to see if the operator has sent you instructions or feedback.",
        {},
        async () => {
          if (!streamCtx) return "No messages";
          const msgs = getPendingMessages(streamCtx.runKey);
          if (msgs.length > 0) {
            stream("chat_response", `Agent read ${msgs.length} message(s) from operator`);
            return `Messages from operator:\n${msgs.join("\n")}`;
          }
          return "No pending messages";
        },
      );

      const allTools = [...role.tools, checkHumanMessagesTool];

      const mcpServerName = `${role.name}-tools`;
      const toolServer = createSdkMcpServer({
        name: mcpServerName,
        version: "1.0.0",
        tools: allTools,
      });

      const agents: Record<string, any> = {};
      if (role.hasDevAgent) {
        agents["dev-agent"] = {
          description:
            "Autonomous coding agent with full file system and shell access. " +
            "Use for implementing features, fixing bugs, refactoring code, " +
            "running tests, and any task that requires reading/writing files or executing commands.",
          prompt:
            "You are an autonomous dev agent working on Pontifexx projects. Implement tasks fully. " +
            "Do not ask questions — make reasonable decisions and proceed.",
          model: role.devAgentModel ?? "opus",
          tools: [...(role.devAgentTools ?? []), "Skill"],
          skills: role.devAgentSkills,
          maxTurns: role.devAgentMaxTurns,
          mcpServers: [mcpServerName],
          criticalSystemReminder_EXPERIMENTAL:
            "ALWAYS run tests/build before claiming done — evidence before assertions. " +
            "Use TDD: write failing test, minimal code to pass, refactor. " +
            "Conventional commits (feat:, fix:, refactor:). " +
            "No debug logs, commented-out code, or unrelated changes. " +
            "YAGNI, DRY, keep it simple.",
        };
      }

      const session = query({
        prompt,
        options: {
          model: role.model,
          cwd: repo?.repoDir ?? process.env.REPO_DIR ?? "/data/repos",
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          maxTurns: role.maxTurns,
          systemPrompt: role.systemPrompt + (streamCtx ? "\n\nYou have a check_human_messages tool available. Call it periodically (every few turns) to check if the human operator has sent you messages or instructions via the dashboard console." : ""),
          settingSources: ["project"],
          allowedTools: ["Skill"],
          effort: role.effort ?? "high",
          maxBudgetUsd: role.maxBudgetUsd,
          disallowedTools: role.disallowedTools,
          hooks: {
            PostToolUse: [{ matcher: "^mcp__", hooks: [mcpAuditHook] }],
            SubagentStop: [{ hooks: [subagentStopHook] }],
          },
          stderr: (data: string) => process.stderr.write(data),
          mcpServers: {
            [mcpServerName]: toolServer,
          },
          agents,
        },
      });

      try {
        for await (const message of session) {
          console.log(formatMessage(message));

          // Stream to dashboard
          if (message.type === "assistant") {
            const content = (message as any)?.message?.content;
            if (Array.isArray(content)) {
              const text = content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim();
              if (text) stream("assistant", text.length > 1000 ? text.slice(0, 1000) + "..." : text);
              const tools = content.filter((b: any) => b.type === "tool_use").map((b: any) => b.name);
              if (tools.length) stream("tool_use", tools.join(", "));
            }
          } else if (message.type === "user") {
            const content = (message as any)?.message?.content;
            if (Array.isArray(content)) {
              const toolResults = content.filter((b: any) => b.type === "tool_result");
              if (toolResults.length) {
                for (const tr of toolResults) {
                  const summary = typeof tr.content === "string"
                    ? tr.content.slice(0, 300)
                    : JSON.stringify(tr.content).slice(0, 300);
                  stream("tool_result", summary);
                }
              }
            }
          }

          // Track rate limit events for work window management
          if (message.type === "rate_limit_event") {
            updateRateLimitState(message as any);
          }

          if (message.type === "result") {
            const msg = message as any;
            costUsd = msg.total_cost_usd ?? 0;
            numTurns = msg.num_turns ?? 0;
            durationMs = msg.duration_ms ?? 0;
            if (msg.subtype === "success") {
              resultText = msg.result;
              stream("result", `Completed: ${resultText.slice(0, 500)}`);
            } else {
              resultText = `Error: ${msg.errors?.join("; ") ?? msg.subtype}`;
              stream("system", resultText);
              console.error(
                `[sdk] result error:`,
                JSON.stringify(msg).slice(0, 500),
              );
            }
          }
        }
      } catch (err) {
        if (resultText) {
          console.warn(
            `[sdk] Process exited with error after success result, ignoring:`,
            err instanceof Error ? err.message : String(err),
          );
        } else {
          throw err;
        }
      }

      return {
        text: resultText || "No response",
        costUsd,
        numTurns,
        durationMs,
      };
    },
  );
}
