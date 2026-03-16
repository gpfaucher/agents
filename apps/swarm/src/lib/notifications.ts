/**
 * ntfy.sh push notifications for agent events.
 */

const NTFY_URL = process.env.NTFY_URL;

export async function notify(
  topic: string,
  title: string,
  message: string,
  opts?: { priority?: number; tags?: string[] },
): Promise<void> {
  if (!NTFY_URL) return;

  try {
    const headers: Record<string, string> = {
      Title: title,
    };
    if (opts?.priority) {
      headers["Priority"] = String(opts.priority);
    }
    if (opts?.tags?.length) {
      headers["Tags"] = opts.tags.join(",");
    }

    await fetch(`${NTFY_URL}/${topic}`, {
      method: "POST",
      headers,
      body: message,
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Best effort — don't block agent execution
  }
}
