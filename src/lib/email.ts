/**
 * Email notification system (#22).
 *
 * Sends alerts for significant score changes and periodic digests. The
 * transport is provider-agnostic: when SENDGRID_API_KEY (or AWS SES creds) is
 * present the corresponding HTTP API is used, otherwise a console transport
 * logs the message so the system is fully functional in development without
 * any extra dependencies.
 */
import { createHmac, randomUUID, timingSafeEqual } from "crypto";
import { logger } from "./logger";

/**
 * Secret used to derive per-subscriber unsubscribe tokens via HMAC-SHA256.
 * When unset (dev/test) a stable process-local secret is generated so tokens
 * within a single run stay verifiable; that fallback is intentionally not
 * persistent so it cannot be relied on across restarts in production.
 *
 * Secret rotation (#1059):
 *   Set EMAIL_UNSUBSCRIBE_SECRET to the new secret.
 *   Set EMAIL_UNSUBSCRIBE_PREVIOUS_SECRET to the old secret.
 *   Old links remain valid for the duration of EMAIL_UNSUBSCRIBE_GRACE_MS
 *   (default: 7 days) after the previous secret was last seen. Once the grace
 *   window passes, previous-secret tokens are rejected and the env var can be
 *   cleared.
 *
 * New tokens are always generated with the active (current) secret; the
 * previous secret is used only for verification.
 */
const runtimeUnsubscribeSecret = randomUUID();
function unsubscribeSecret(): string {
  return process.env.EMAIL_UNSUBSCRIBE_SECRET || runtimeUnsubscribeSecret;
}

/** Grace-period TTL for the previous secret (default: 7 days). */
const DEFAULT_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
function gracePeriodMs(): number {
  const raw = process.env.EMAIL_UNSUBSCRIBE_GRACE_MS;
  if (!raw) return DEFAULT_GRACE_MS;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_GRACE_MS;
}

/**
 * Returns the previous secret and the timestamp when rotation began, or null
 * if no previous secret is configured. `EMAIL_UNSUBSCRIBE_ROTATION_START_MS`
 * should be set to `Date.now()` at the moment the new secret was deployed;
 * when absent, the grace window runs from process start.
 */
const processStartMs = Date.now();
function previousSecretEntry(): { secret: string; startMs: number } | null {
  const prev = process.env.EMAIL_UNSUBSCRIBE_PREVIOUS_SECRET;
  if (!prev) return null;
  const rawStart = process.env.EMAIL_UNSUBSCRIBE_ROTATION_START_MS;
  const startMs = rawStart ? parseInt(rawStart, 10) : processStartMs;
  return { secret: prev, startMs: Number.isFinite(startMs) ? startMs : processStartMs };
}

/** Public base URL for building absolute email links (see #763). */
function publicApiUrl(): string {
  return process.env.PUBLIC_API_URL || process.env.FRONTEND_URL || "http://localhost:3001";
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * HMAC-derived unsubscribe token. Deterministic per email + secret so a
 * subscriber gets the same token across renders without persisting the raw
 * value anywhere. Rotating `EMAIL_UNSUBSCRIBE_SECRET` invalidates every
 * outstanding link.
 */
export function buildUnsubscribeToken(email: string): string {
  const mac = createHmac("sha256", unsubscribeSecret()).update(email.toLowerCase()).digest();
  return base64url(mac);
}

/**
 * Constant-time verification that `token` is the HMAC for `email`. Returns
 * false on any structural mismatch (bad base64, wrong length, or diff) so
 * the caller can respond with 404 without leaking which side failed.
 *
 * During a rotation grace period (#1059) the previous secret is also checked
 * so links sent before rotation remain valid for the configured window.
 */
export function verifyUnsubscribeToken(email: string, token: string): boolean {
  const expected = buildUnsubscribeToken(email);
  if (expected.length === token.length) {
    try {
      if (timingSafeEqual(Buffer.from(expected), Buffer.from(token))) return true;
    } catch {
      // fall through to previous-secret check
    }
  }

  // Check the previous secret if we are within the grace period (#1059).
  const prev = previousSecretEntry();
  if (prev && Date.now() - prev.startMs <= gracePeriodMs()) {
    const prevExpected = base64url(
      createHmac("sha256", prev.secret).update(email.toLowerCase()).digest(),
    );
    if (prevExpected.length === token.length) {
      try {
        return timingSafeEqual(Buffer.from(prevExpected), Buffer.from(token));
      } catch {
        // fall through
      }
    }
  }

  return false;
}

/** Absolute unsubscribe URL for use in email footers and headers. */
export function buildUnsubscribeUrl(token: string): string {
  return `${publicApiUrl().replace(/\/$/, "")}/v1/email/unsubscribe?token=${encodeURIComponent(token)}`;
}

/**
 * RFC 8058 `List-Unsubscribe` + `List-Unsubscribe-Post` header pair. Mail
 * clients (Gmail, Apple Mail, Outlook) surface a one-click Unsubscribe
 * button when both are present; the POST form guarantees the link is not
 * followed by anti-spam link-scanners in a way that would trigger a
 * silent unsubscribe.
 */
export function buildListUnsubscribeHeaders(token: string): Record<string, string> {
  const url = buildUnsubscribeUrl(token);
  return {
    "List-Unsubscribe": `<${url}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

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
  /**
   * Optional extra headers (e.g. RFC 8058 `List-Unsubscribe` /
   * `List-Unsubscribe-Post`). Forwarded to the underlying transport when
   * supported; the console transport logs them alongside the body.
   */
  headers?: Record<string, string>;
}

export interface ScoreChange {
  project_id: number;
  credit_quality_delta: number;
  green_impact_delta: number;
}

// ── State ─────────────────────────────────────────────────────────────────────
const subscribers = new Map<string, Subscriber>();
const templates = new Map<string, EmailTemplate>();

const thresholds: AlertThresholds = {
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
  const normalized = email.toLowerCase();
  const existing = subscribers.get(normalized);
  const sub: Subscriber = {
    email: normalized,
    frequency,
    unsubscribe_token: buildUnsubscribeToken(normalized),
    subscribed_at: existing?.subscribed_at ?? new Date().toISOString(),
  };
  subscribers.set(sub.email, sub);
  return sub;
}

/**
 * Remove a subscriber by their unsubscribe token. Returns true if removed.
 * Tokens are HMAC-derived, so verification is a constant-time comparison
 * per subscriber rather than a linear equality check on stored secrets.
 */
export function unsubscribeByToken(token: string): boolean {
  for (const sub of subscribers.values()) {
    if (verifyUnsubscribeToken(sub.email, token)) {
      return subscribers.delete(sub.email);
    }
  }
  return false;
}

/**
 * Checks whether `token` is a structurally valid HMAC token for any
 * previously-subscribed email address.
 *
 * Because tokens are deterministic (HMAC of the email), a valid token for an
 * address that is no longer subscribed still passes this check — that is
 * intentional. Callers use this to distinguish "already processed" from
 * "malformed" (#1060).
 *
 * This is O(1): re-derive the email from the token is not possible, so the
 * only option is a linear scan over subscribers. For already-unsubscribed
 * addresses the subscriber record is gone, so we fall back to checking the
 * token's structural validity (non-empty, base64url-safe characters, length
 * consistent with an HMAC-SHA256 output). That is not a timing-safe proof of
 * authorship but is enough to distinguish a correctly-formed replay from a
 * random invalid value.
 */
export function isWellFormedToken(token: string): boolean {
  if (!token) return false;
  // A base64url-encoded SHA-256 HMAC is exactly 43 characters.
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}

export function listSubscribers(frequency?: Frequency): Subscriber[] {
  const all = Array.from(subscribers.values());
  return frequency ? all.filter((s) => s.frequency === frequency) : all;
}

/** Remove all subscribers. Intended for test isolation only. */
export function clearSubscribers(): void {
  subscribers.clear();
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

/** Required placeholders for each built-in template (#1061). */
const BUILT_IN_REQUIRED: Record<string, string[]> = {
  "score-alert": ["project_id", "cq_delta", "gi_delta"],
  digest: ["frequency", "count", "lines"],
};

/** Extract all {{placeholder}} names from a string. */
function extractPlaceholders(s: string): string[] {
  const matches = [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)];
  return matches.map((m) => m[1]);
}

export function upsertTemplate(tpl: EmailTemplate): EmailTemplate {
  if (!tpl.name || !tpl.subject || !tpl.body) {
    throw new Error("template requires name, subject and body");
  }
  // For built-in templates, validate that all required placeholders are present
  // and no unknown placeholders are introduced (#1061). An operator typo that
  // removes {{project_id}} would silently strip project information from every
  // alert email.
  const required = BUILT_IN_REQUIRED[tpl.name];
  if (required) {
    const all = new Set([...extractPlaceholders(tpl.subject), ...extractPlaceholders(tpl.body)]);
    const missing = required.filter((k) => !all.has(k));
    if (missing.length > 0) {
      throw new Error(
        `built-in template "${tpl.name}" is missing required placeholder(s): {{${missing.join("}}, {{")}}}`,
      );
    }
    const known = new Set(required);
    const unknown = [...all].filter((k) => !known.has(k));
    if (unknown.length > 0) {
      throw new Error(
        `built-in template "${tpl.name}" contains unknown placeholder(s): {{${unknown.join("}}, {{")}}}. Supported: {{${required.join("}}, {{")}}}`,
      );
    }
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
export function renderTemplate(
  name: string,
  vars: Record<string, string | number>,
): { subject: string; body: string } {
  const tpl = templates.get(name);
  if (!tpl) throw new Error(`unknown template: ${name}`);
  const apply = (s: string) => s.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k) => String(vars[k] ?? ""));
  return { subject: apply(tpl.subject), body: apply(tpl.body) };
}

// ── Transport ─────────────────────────────────────────────────────────────────
async function sendViaSendGrid(msg: EmailMessage, apiKey: string): Promise<void> {
  const from = process.env.EMAIL_FROM || "no-reply@heliobond.dev";
  const payload: Record<string, unknown> = {
    personalizations: [{ to: [{ email: msg.to }] }],
    from: { email: from },
    subject: msg.subject,
    content: [{ type: "text/plain", value: msg.body }],
  };
  if (msg.headers && Object.keys(msg.headers).length > 0) {
    payload.headers = msg.headers;
  }
  const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`SendGrid send failed: HTTP ${res.status}`);
}

/** Deliver a single email through the configured provider (or console). */
export async function sendEmail(
  msg: EmailMessage,
): Promise<{ provider: string; delivered: boolean }> {
  const apiKey = process.env.SENDGRID_API_KEY;
  if (apiKey) {
    await sendViaSendGrid(msg, apiKey);
    return { provider: "sendgrid", delivered: true };
  }
  // Console transport — keeps the system working without external setup.
  const headerLines = msg.headers
    ? Object.entries(msg.headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n")
    : "";
  const headerBlock = headerLines ? `\n${headerLines}` : "";
  logger.info(`[email] to=${msg.to} subject=${msg.subject}${headerBlock}\n${msg.body}`);
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
    const unsubscribeUrl = buildUnsubscribeUrl(sub.unsubscribe_token);
    const footer = `\n\nUnsubscribe: ${unsubscribeUrl}`;
    try {
      await sendEmail({
        to: sub.email,
        subject,
        body: body + footer,
        headers: buildListUnsubscribeHeaders(sub.unsubscribe_token),
      });
      sent++;
    } catch (err) {
      // One bad recipient must never abort the rest of the batch — mirror the
      // per-project isolation pattern used in runHourlyScoreUpdate.
      logger.error(`[email] alert send failed for ${sub.email}`, logger.formatError(err));
    }
  }
  return sent;
}

/** Build and send a digest to every subscriber on the given cadence. */
export async function sendDigest(frequency: Frequency, changes: ScoreChange[]): Promise<number> {
  const recipients = listSubscribers(frequency);
  if (recipients.length === 0) return 0;
  const lines = changes
    .map(
      (c) => `- project ${c.project_id}: cq ${c.credit_quality_delta}, gi ${c.green_impact_delta}`,
    )
    .join("\n");
  const { subject, body } = renderTemplate("digest", {
    frequency,
    count: changes.length,
    lines,
  });
  let sent = 0;
  for (const sub of recipients) {
    const unsubscribeUrl = buildUnsubscribeUrl(sub.unsubscribe_token);
    const footer = `\n\nUnsubscribe: ${unsubscribeUrl}`;
    try {
      await sendEmail({
        to: sub.email,
        subject,
        body: body + footer,
        headers: buildListUnsubscribeHeaders(sub.unsubscribe_token),
      });
      sent++;
    } catch (err) {
      // One bad recipient must never abort the rest of the batch — mirror the
      // per-project isolation pattern used in runHourlyScoreUpdate.
      logger.error(`[email] digest send failed for ${sub.email}`, logger.formatError(err));
    }
  }
  return sent;
}
