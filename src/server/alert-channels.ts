import { sendEmail } from "./email";
import type { AlertPayload } from "./alert-router";

// Curated alert-channel adapters. Unlike workflow providers (AI-authored,
// arbitrary method names), these target fixed, documented APIs — so delivery is
// reliable and engine-independent (a plain fetch, no run engine). Each adapter
// THROWS on failure; the sink wraps every send so one bad channel never blocks
// the others, and the log channel is the guaranteed floor.
//
// Monitor-handler FLOWS (the workflow that runs on an alert) are not channels —
// they auto-dispatch from the alert service when a flow has a "monitor" trigger.
// Channels here are pure notification sinks.

export type ChannelKind =
  | "telegram"
  | "slack"
  | "discord"
  | "email"
  | "webhook";

// Per-kind secret/config shape (stored encrypted in the vault).
export interface TelegramSecret { botToken: string; chatId: string }
export interface WebhookSecret { webhookUrl: string }
// Discord supports two delivery modes: an incoming-webhook URL, or a bot token
// + channel id (the Bot API — same as a workflow's Discord node).
export interface DiscordBotSecret { botToken: string; channelId: string }
export interface EmailSecret { to: string }
export interface WebhookPostSecret { url: string } // generic "POST the alert JSON here"
export type ChannelSecret =
  | TelegramSecret
  | WebhookSecret
  | DiscordBotSecret
  | EmailSecret
  | WebhookPostSecret;

// Injectable fetch so adapters are testable without real network.
export type Fetch = typeof fetch;

// What deliverToChannel receives — a formatted line for chat channels, a subject
// for email, and the structured event for the webhook channel.
export interface DeliveryPayload {
  text: string;
  subject: string;
  event: AlertPayload;
}

async function ensureOk(res: Response, channel: string): Promise<void> {
  if (res.ok) return;
  const body = await res.text().catch(() => "");
  throw new Error(`${channel} send failed (${res.status}): ${body.slice(0, 200)}`);
}

export async function sendTelegram(
  secret: TelegramSecret,
  text: string,
  f: Fetch = fetch,
): Promise<void> {
  if (!secret.botToken || !secret.chatId) throw new Error("telegram: missing botToken/chatId");
  const res = await f(`https://api.telegram.org/bot${secret.botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: secret.chatId, text, disable_web_page_preview: true }),
  });
  await ensureOk(res, "telegram");
}

export async function sendSlack(
  secret: WebhookSecret,
  text: string,
  f: Fetch = fetch,
): Promise<void> {
  if (!secret.webhookUrl) throw new Error("slack: missing webhookUrl");
  const res = await f(secret.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  await ensureOk(res, "slack");
}

export async function sendDiscord(
  secret: WebhookSecret | DiscordBotSecret,
  text: string,
  f: Fetch = fetch,
): Promise<void> {
  const content = text.slice(0, 1900); // discord 2000-char cap
  if ("botToken" in secret && secret.botToken) {
    // Bot API: POST to the channel with a Bot authorization header.
    if (!secret.channelId) throw new Error("discord: missing channelId");
    const res = await f(
      `https://discord.com/api/v10/channels/${secret.channelId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bot ${secret.botToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content }),
      },
    );
    await ensureOk(res, "discord");
    return;
  }
  if (!("webhookUrl" in secret) || !secret.webhookUrl)
    throw new Error("discord: need a webhookUrl or botToken+channelId");
  const res = await f(secret.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  await ensureOk(res, "discord");
}

// Generic webhook: POST the structured alert JSON to the user's own URL.
export async function sendWebhook(
  secret: WebhookPostSecret,
  event: AlertPayload,
  f: Fetch = fetch,
): Promise<void> {
  if (!secret.url) throw new Error("webhook: missing url");
  const res = await f(secret.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
  });
  await ensureOk(res, "webhook");
}

// Deliver to a network channel by kind. (`workflow` is handled by the service,
// not here.)
export async function deliverToChannel(
  kind: ChannelKind,
  secret: ChannelSecret,
  payload: DeliveryPayload,
  f: Fetch = fetch,
): Promise<void> {
  switch (kind) {
    case "telegram":
      return sendTelegram(secret as TelegramSecret, payload.text, f);
    case "slack":
      return sendSlack(secret as WebhookSecret, payload.text, f);
    case "discord":
      return sendDiscord(secret as WebhookSecret | DiscordBotSecret, payload.text, f);
    case "webhook":
      return sendWebhook(secret as WebhookPostSecret, payload.event, f);
    case "email": {
      const to = (secret as EmailSecret).to;
      if (!to) throw new Error("email: missing recipient");
      const html = `<pre style="font:14px ui-monospace,monospace">${escapeHtml(payload.text)}</pre>`;
      return sendEmail(to, payload.subject, html);
    }
    default:
      throw new Error(`channel kind not deliverable here: ${kind}`);
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
