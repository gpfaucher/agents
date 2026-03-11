/**
 * Alerting — send notifications when agents fail or get stuck.
 * Supports Slack and Discord webhook formats.
 */

const ALERT_WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL;

export async function sendAlert(message: string, extra?: Record<string, unknown>): Promise<void> {
  console.error(`[alert] ${message}`);

  if (!ALERT_WEBHOOK_URL) return;

  try {
    // Detect format: Discord uses "content", Slack uses "text"
    const isDiscord = ALERT_WEBHOOK_URL.includes("discord.com");
    const body = isDiscord
      ? { content: message, embeds: extra ? [{ fields: Object.entries(extra).map(([name, value]) => ({ name, value: String(value), inline: true })) }] : undefined }
      : { text: message, blocks: extra ? [{ type: "section", text: { type: "mrkdwn", text: Object.entries(extra).map(([k, v]) => `*${k}:* ${v}`).join("\n") } }] : undefined };

    await fetch(ALERT_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error(`[alert] Failed to send alert:`, err instanceof Error ? err.message : String(err));
  }
}
