import {
  query,
  createSdkMcpServer,
  type HookCallback,
  type SubagentStopHookInput,
} from "@anthropic-ai/claude-agent-sdk";
import { traceAgent } from "./lib/tracing.js";
import { updateRateLimitState } from "./lib/rate-limiter.js";
import type { RoleConfig } from "./roles/index.js";
import type { RepoContext } from "./lib/repos.js";

export interface AgentResult {
  text: string;
  costUsd: number;
  numTurns: number;
  durationMs: number;
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

      const mcpServerName = `${role.name}-tools`;
      const toolServer = createSdkMcpServer({
        name: mcpServerName,
        version: "1.0.0",
        tools: role.tools,
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
          systemPrompt: role.systemPrompt,
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
            } else {
              resultText = `Error: ${msg.errors?.join("; ") ?? msg.subtype}`;
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
