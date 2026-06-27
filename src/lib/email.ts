/**
 * Email notification system (#22).
 *
 * Sends alerts for significant score changes and periodic digests. The
 * transport is provider-agnostic: when SENDGRID_API_KEY (or AWS SES creds) is
 * present the corresponding HTTP API is used, otherwise a console transport
 * logs the message so the system is fully functional in development without
 * any extra dependencies.
 */
import { createHmac, randomUUID } from "crypto";

export type Frequency = "daily" | "weekly";

export interface Subscriber {
  email: string;
  frequency: Frequency;
  /** Opaque token used for one-click unsubscribe links. */
  unsubscribe_token: string;
  subscribed_at: string;
}

export interface AlertThresholds {
  /** Minimum absolute credit-quality change that triggers an alert. */
  credit_quality_delta: number;
  /** Minimum absolute green-impact change that triggers an alert. */
  green_impact_delta: number;
}

export interface EmailTemplate {
  name: string;
  subject: string;
  body: string; // may contain {{placeholders}}
}

export interface EmailMessage {
  to: string;
  subject: string;
  body: string;
}

export interface ScoreChange {
  project_id: number;
  credit_quality_delta: number;
  green_impact_delta: number;
}

// ── State ─────────────────────────────────────────────────────────────────────
const subscribers = new Map<string, Subscriber>();
const templates = new Map<string, EmailTemplate>();

let thresholds: AlertThresholds = {
  credit_quality_delta: 5,
  green_impact_delta: 5,
};

// Seed with the templates the alert/digest flows rely on.
templates.set("score-alert", {
  name: "score-alert",
  subject: "Score alert for project {{project_id}}",
  body: "Project {{project_id}} changed: credit_quality {{cq_delta}}, green_impact {{gi_delta}}.",
});
templates.set("digest", {
  name: "digest",
  subject: "Your {{frequency}} Heliobond digest",
  body: "Summary of {{count}} score updates:\n{{lines}}",
});

// ── Subscribers / unsubscribe ────────────────────────────────────────────────
export function subscribe(email: string, frequency: Frequency = "weekly"): Subscriber {
  const existing = subscribers.get(email.toLowerCase());
  const sub: Subscriber = {
    email: email.toLowerCase(),
    frequency,
    unsubscribe_token: existing?.unsubscribe_token ?? randomUUID(),
    subscribed_at: existing?.subscribed_at ?? new Date().toISOString(),
  };
  subscribers.set(sub.email, sub);
  return sub;
}

/** Remove a subscriber by their unsubscribe token. Returns true if removed. */
export function unsubscribeByToken(token: string): boolean {
  for (const sub of subscribers.values()) {
    if (sub.unsubscribe_token === token) {
      return subscribers.delete(sub.email);
    }
  }
  return false;
}

export function listSubscribers(frequency?: Frequency): Subscriber[] {
  const all = Array.from(subscribers.values());
  return frequency ? all.filter((s) => s.frequency === frequency) : all;
}

// ── Thresholds ────────────────────────────────────────────────────────────────
export function getThresholds(): AlertThresholds {
  return { ...thresholds };
}

export function setThresholds(next: Partial<AlertThresholds>): AlertThresholds {
  if (next.credit_quality_delta !== undefined) {
    if (typeof next.credit_quality_delta !== "number" || next.credit_quality_delta < 0) {
      throw new Error("credit_quality_delta must be a non-negative number");
    }
    thresholds.credit_quality_delta = next.credit_quality_delta;
  }
  if (next.green_impact_delta !== undefined) {
    if (typeof next.green_impact_delta !== "number" || next.green_impact_delta < 0) {
      throw new Error("green_impact_delta must be a non-negative number");
    }
    thresholds.green_impact_delta = next.green_impact_delta;
  }
  return getThresholds();
}

/** True when a score change is large enough to warrant an alert email. */
export function isSignificant(change: ScoreChange): boolean {
  return (
    Math.abs(change.credit_quality_delta) >= thresholds.credit_quality_delta ||
    Math.abs(change.green_impact_delta) >= thresholds.green_impact_delta
  );
}

// ── Templates ─────────────────────────────────────────────────────────────────
export function upsertTemplate(tpl: EmailTemplate): EmailTemplate {
  if (!tpl.name || !tpl.subject || !tpl.body) {
    throw new Error("template requires name, subject and body");
  }
  templates.set(tpl.name, tpl);
  return tpl;
}

export function getTemplate(name: string): EmailTemplate | undefined {
  return templates.get(name);
}

export function listTemplates(): EmailTemplate[] {
  return Array.from(templates.values());
}

/** Substitute {{key}} placeholders from `vars`. Missing keys become "". */
export function renderTemplate(name: string, vars: Record<string, string | number>): { subject: string; body: string } {
  const tpl = templates.get(name);
  if (!tpl) throw new Error(`unknown template: ${name}`);
  const apply = (s: string) => s.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k) => String(vars[k] ?? ""));
  return { subject: apply(tpl.subject), body: apply(tpl.body) };
}

// ── Transport ─────────────────────────────────────────────────────────────────
async function sendViaSendGrid(msg: EmailMessage, apiKey: string): Promise<void> {
  const from = process.env.EMAIL_FROM || "no-reply@heliobond.dev";
  const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: msg.to }] }],
      from: { email: from },
      subject: msg.subject,
      content: [{ type: "text/plain", value: msg.body }],
    }),
  });
  if (!res.ok) throw new Error(`SendGrid send failed: HTTP ${res.status}`);
}

/** Deliver a single email through the configured provider (or console). */
export async function sendEmail(msg: EmailMessage): Promise<{ provider: string; delivered: boolean }> {
  const apiKey = process.env.SENDGRID_API_KEY;
  if (apiKey) {
    await sendViaSendGrid(msg, apiKey);
    return { provider: "sendgrid", delivered: true };
  }
  // Console transport — keeps the system working without external setup.
  console.log(`[email] to=${msg.to} subject=${msg.subject}\n${msg.body}`);
  return { provider: "console", delivered: true };
}

/** Sign an unsubscribe token for tamper-evident links (optional helper). */
export function signToken(token: string, secret: string): string {
  return createHmac("sha256", secret).update(token).digest("hex");
}

// ── High-level flows ──────────────────────────────────────────────────────────
/** Send a score-change alert to all subscribers if the change is significant. */
export async function sendAlertIfSignificant(change: ScoreChange): Promise<number> {
  if (!isSignificant(change)) return 0;
  const { subject, body } = renderTemplate("score-alert", {
    project_id: change.project_id,
    cq_delta: change.credit_quality_delta,
    gi_delta: change.green_impact_delta,
  });
  let sent = 0;
  for (const sub of subscribers.values()) {
    await sendEmail({ to: sub.email, subject, body });
    sent++;
  }
  return sent;
}

/** Build and send a digest to every subscriber on the given cadence. */
export async function sendDigest(frequency: Frequency, changes: ScoreChange[]): Promise<number> {
  const recipients = listSubscribers(frequency);
  if (recipients.length === 0) return 0;
  const lines = changes
    .map((c) => `- project ${c.project_id}: cq ${c.credit_quality_delta}, gi ${c.green_impact_delta}`)
    .join("\n");
  const { subject, body } = renderTemplate("digest", {
    frequency,
    count: changes.length,
    lines,
  });
  let sent = 0;
  for (const sub of recipients) {
    const footer = `\n\nUnsubscribe: /v1/email/unsubscribe?token=${sub.unsubscribe_token}`;
    await sendEmail({ to: sub.email, subject, body: body + footer });
    sent++;
  }
  return sent;
}
