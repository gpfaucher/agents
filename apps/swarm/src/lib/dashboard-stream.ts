/**
 * Stream agent messages to the dashboard for live output display.
 */

const DASHBOARD_URL = process.env.DASHBOARD_URL;

export async function streamMessage(
  runKey: string,
  agentRole: string,
  issueIdentifier: string,
  msgType: string,
  content: string,
): Promise<void> {
  if (!DASHBOARD_URL) return;

  try {
    await fetch(`${DASHBOARD_URL}/api/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        runKey,
        agentRole,
        issueIdentifier,
        msgType,
        content,
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Best effort — don't block agent execution
  }
}
