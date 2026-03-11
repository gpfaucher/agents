import { tool } from "@anthropic-ai/claude-agent-sdk";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

const exec = promisify(execFileCb);

export const prReviewWithComments = tool(
  "pr_review_with_comments",
  "Submit a GitHub PR review with inline line-by-line comments and optional code suggestions. Lines must exist in the PR diff.",
  {
    repo: z.string().describe("GitHub repo identifier, e.g. 'owner/repo'"),
    prNumber: z.number().describe("PR number"),
    event: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]).describe("Review action"),
    body: z.string().describe("Overall review comment"),
    comments: z.array(z.object({
      path: z.string().describe("File path relative to repo root"),
      line: z.number().describe("Line number in the NEW file version (right side of diff). Must be within a diff hunk."),
      side: z.enum(["LEFT", "RIGHT"]).default("RIGHT").describe("LEFT = old file, RIGHT = new file (default)"),
      start_line: z.number().optional().describe("For multi-line comments: first line of the range (line becomes the last line)"),
      start_side: z.enum(["LEFT", "RIGHT"]).optional().describe("Side for start_line (defaults to match side)"),
      body: z.string().describe("Comment body. Use ```suggestion\\n...\\n``` blocks for code suggestions."),
      subject_type: z.enum(["line", "file"]).default("line").describe("'file' to attach comment to the file instead of a specific line"),
    })).optional().describe("Inline comments on specific lines in the diff"),
  },
  async ({ repo, prNumber, event, body, comments }) => {
    // Build the review payload
    const reviewBody: Record<string, unknown> = {
      event,
      body,
    };

    if (comments?.length) {
      reviewBody.comments = comments.map((c) => {
        const comment: Record<string, unknown> = {
          path: c.path,
          body: c.body,
        };

        if (c.subject_type === "file") {
          comment.subject_type = "file";
        } else {
          comment.line = c.line;
          comment.side = c.side || "RIGHT";
          if (c.start_line !== undefined) {
            comment.start_line = c.start_line;
            comment.start_side = c.start_side || c.side || "RIGHT";
          }
        }

        return comment;
      });
    }

    const { writeFile, unlink } = await import("node:fs/promises");
    const tmpFile = `/tmp/review-${prNumber}-${Date.now()}.json`;

    try {
      await writeFile(tmpFile, JSON.stringify(reviewBody));

      const { stdout, stderr } = await exec(
        "gh",
        ["api", `repos/${repo}/pulls/${prNumber}/reviews`, "--method", "POST", "--input", tmpFile],
        { timeout: 30_000 },
      );

      return {
        content: [{
          type: "text" as const,
          text: `PR #${prNumber} reviewed (${event})${comments?.length ? ` with ${comments.length} inline comments` : ""}`,
        }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // stderr from gh often contains the actual GitHub API error
      const stderr = (err as any)?.stderr;
      const detail = stderr ? `\n\nGitHub API error:\n${stderr}` : "";

      // If line comments failed, retry without them (file-level fallback)
      if (comments?.length && (msg.includes("422") || msg.includes("Unprocessable") || msg.includes("pull_request_review_thread.line"))) {
        console.warn(`[pr-review] Inline comments failed for PR #${prNumber}, retrying as body-only review with comments appended`);

        // Append inline comments to the body as a fallback
        const commentSummary = comments.map((c) =>
          `**${c.path}${c.subject_type !== "file" ? `:${c.line}` : ""}**\n${c.body}`
        ).join("\n\n---\n\n");

        const fallbackBody: Record<string, unknown> = {
          event,
          body: `${body}\n\n---\n\n## Inline Comments\n\n${commentSummary}`,
        };

        try {
          const tmpFile2 = `/tmp/review-${prNumber}-fallback-${Date.now()}.json`;
          await writeFile(tmpFile2, JSON.stringify(fallbackBody));
          try {
            await exec(
              "gh",
              ["api", `repos/${repo}/pulls/${prNumber}/reviews`, "--method", "POST", "--input", tmpFile2],
              { timeout: 30_000 },
            );
          } finally {
            await unlink(tmpFile2).catch(() => {});
          }
          return {
            content: [{
              type: "text" as const,
              text: `PR #${prNumber} reviewed (${event}) — inline comments failed (lines not in diff?), posted as body instead`,
            }],
          };
        } catch (fallbackErr) {
          const fbMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
          return { content: [{ type: "text" as const, text: `Review failed (including fallback): ${fbMsg}${detail}` }] };
        }
      }

      return { content: [{ type: "text" as const, text: `Review failed: ${msg}${detail}` }] };
    } finally {
      await unlink(tmpFile).catch(() => {});
    }
  },
);

export const ghGetPrReviewComments = tool(
  "gh_get_pr_review_comments",
  "Fetch review comments and feedback from a GitHub PR. Use this to read reviewer feedback before addressing requested changes.",
  {
    repo: z.string().describe("GitHub repo identifier, e.g. 'owner/repo'"),
    prNumber: z.number().describe("PR number"),
  },
  async ({ repo, prNumber }) => {
    try {
      // Fetch reviews (top-level review summaries)
      const { stdout: reviewsRaw } = await exec(
        "gh",
        ["api", `repos/${repo}/pulls/${prNumber}/reviews`, "--jq",
          `.[] | "### Review by \\(.user.login) (\\(.state))\\n\\(.body // \"(no body)\")"`,
        ],
        { timeout: 30_000 },
      );

      // Fetch inline review comments (line-level feedback)
      const { stdout: commentsRaw } = await exec(
        "gh",
        ["api", `repos/${repo}/pulls/${prNumber}/comments`, "--jq",
          `.[] | "**\\(.path):\\(.line // .original_line // \"file\")** by \\(.user.login)\\n\\(.body)\\n"`,
        ],
        { timeout: 30_000 },
      );

      const parts: string[] = [];

      if (reviewsRaw.trim()) {
        parts.push("## Reviews\n" + reviewsRaw.trim());
      }

      if (commentsRaw.trim()) {
        parts.push("## Inline Comments\n" + commentsRaw.trim());
      }

      if (parts.length === 0) {
        return { content: [{ type: "text" as const, text: `No reviews or comments found on PR #${prNumber}` }] };
      }

      return { content: [{ type: "text" as const, text: parts.join("\n\n---\n\n") }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `Failed to fetch PR comments: ${msg}` }] };
    }
  },
);
