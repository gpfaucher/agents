import { tool } from "@anthropic-ai/claude-agent-sdk";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

const exec = promisify(execFileCb);

export const prReviewWithComments = tool(
  "pr_review_with_comments",
  "Submit a GitHub PR review with inline line-by-line comments and optional code suggestions. More detailed than gh_pr_review.",
  {
    repo: z.string().describe("GitHub repo identifier, e.g. 'owner/repo'"),
    prNumber: z.number().describe("PR number"),
    event: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]).describe("Review action"),
    body: z.string().describe("Overall review comment"),
    comments: z.array(z.object({
      path: z.string().describe("File path relative to repo root"),
      line: z.number().describe("Line number in the diff to comment on"),
      body: z.string().describe("Comment body. Use ```suggestion\\n...\\n``` blocks for code suggestions."),
    })).optional().describe("Inline comments on specific lines"),
  },
  async ({ repo, prNumber, event, body, comments }) => {
    // Build the review via gh api
    const reviewBody: Record<string, unknown> = {
      event,
      body,
    };

    if (comments?.length) {
      reviewBody.comments = comments.map((c) => ({
        path: c.path,
        line: c.line,
        body: c.body,
      }));
    }

    try {
      const { writeFile, unlink } = await import("node:fs/promises");
      const tmpFile = `/tmp/review-${prNumber}-${Date.now()}.json`;
      await writeFile(tmpFile, JSON.stringify(reviewBody));

      try {
        await exec(
          "gh",
          ["api", `repos/${repo}/pulls/${prNumber}/reviews`, "--method", "POST", "--input", tmpFile],
          { timeout: 30_000 },
        );
      } finally {
        await unlink(tmpFile).catch(() => {});
      }

      return {
        content: [{
          type: "text" as const,
          text: `PR #${prNumber} reviewed (${event})${comments?.length ? ` with ${comments.length} inline comments` : ""}`,
        }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `Review failed: ${msg}` }] };
    }
  },
);
