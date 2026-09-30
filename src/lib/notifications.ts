/**
 * Investor notifications (#661).
 *
 * Per-address preferences plus delivery of chain-derived events
 * (yield distributed, withdrawal queued/claimable, material score change) by
 * double opt-in email and HMAC-signed webhook. State is in-memory, matching
 * ./email and ./webhooks.
 *
 * Investor preferences are guarded by the regular API-key auth; creator
 * application state changes (see lib/creatorOnboarding) are additionally
 * delivered through the `creator_application_status` event by wallet address.
 */
import { createHmac, randomBytes } from "crypto";
import { sendEmail } from "./email";
import { validatePublicUrl } from "./ssrf";
import { withRetry } from "./retry";
import { logger } from "./logger";

export type NotificationEventType =
  | "yield_distributed"
  | "withdrawal_queued"
  | "withdrawal_claimable"
  | "score_changed"
  | "creator_application_status";

export const EVENT_TYPES: readonly NotificationEventType[] = [
  "yield_distributed",
  "withdrawal_queued",
  "withdrawal_claimable",
  "score_changed",
  "creator_application_status",
];

export interface NotificationPreferences {
  address: string;
  email: string | null;
  email_verified: boolean;
  webhook_url: string | null;
  events: NotificationEventType[];
  /** Minimum absolute change in either score that triggers `score_changed`. */
  score_change_threshold: number;
  /** Restrict `score_changed` to these project ids; empty = all projects. */
  project_ids: number[];
  updated_at: string;
}

interface Record_ extends NotificationPreferences {
  webhook_secret: string;
  unsubscribe_token: string;
  confirm_token: string | null;
}

export interface NotificationEvent {
  type: NotificationEventType;
  /** Stable id of the underlying chain event (e.g. `${ledger}-${txHash}`); used for de-duplication. */
  id: string;
  /** Recipient address; omit to fan out to every opted-in address (score changes). */
  address?: string;
  project_id?: number;
  data: Record<string, unknown>;
}

const records = new Map<string, Record_>();
const byUnsubscribeToken = new Map<string, string>();
const byConfirmToken = new Map<string, string>();
const delivered = new Set<string>();

// Domain labels exclude "." so the pattern is unambiguous (no polynomial backtracking).
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;
const EMAIL_MAX_LENGTH = 254;
const DEFAULT_THRESHOLD = 5;

function token(): string {
  return randomBytes(24).toString("hex");
}

function baseUrl(): string {
  return (process.env.PUBLIC_BASE_URL || "http://localhost:3001").replace(/\/$/, "");
}

function publicView(r: Record_): NotificationPreferences {
  const { webhook_secret: _s, unsubscribe_token: _u, confirm_token: _c, ...rest } = r;
  return rest;
}

export function getPreferences(address: string): NotificationPreferences | null {
  const r = records.get(address);
  return r ? publicView(r) : null;
}

/** The webhook signing secret, returned only when it is (re)generated. */
export interface UpdateResult {
  preferences: NotificationPreferences;
  webhook_secret?: string;
  confirmation_sent: boolean;
}

export interface PreferenceInput {
  email?: string | null;
  webhook_url?: string | null;
  events?: NotificationEventType[];
  score_change_threshold?: number;
  project_ids?: number[];
}

export async function updatePreferences(
  address: string,
  input: PreferenceInput,
): Promise<UpdateResult> {
  if (
    input.email != null &&
    (input.email.length > EMAIL_MAX_LENGTH || !EMAIL_RE.test(input.email))
  ) {
    throw new Error("email must be a valid email address");
  }
  if (input.events && !input.events.every((e) => EVENT_TYPES.includes(e))) {
    throw new Error(`events must be a subset of: ${EVENT_TYPES.join(", ")}`);
  }
  if (
    input.score_change_threshold !== undefined &&
    !(Number.isFinite(input.score_change_threshold) && input.score_change_threshold >= 0)
  ) {
    throw new Error("score_change_threshold must be a non-negative number");
  }
  if (input.project_ids && !input.project_ids.every((n) => Number.isInteger(n) && n >= 1)) {
    throw new Error("project_ids must contain only positive integers");
  }
  let webhookUrl: string | null | undefined = input.webhook_url;
  if (typeof webhookUrl === "string") webhookUrl = await validatePublicUrl(webhookUrl);

  let r = records.get(address);
  let webhookSecret: string | undefined;
  if (!r) {
    r = {
      address,
      email: null,
      email_verified: false,
      webhook_url: null,
      events: [...EVENT_TYPES],
      score_change_threshold: DEFAULT_THRESHOLD,
      project_ids: [],
      updated_at: "",
      webhook_secret: token(),
      unsubscribe_token: token(),
      confirm_token: null,
    };
    records.set(address, r);
    byUnsubscribeToken.set(r.unsubscribe_token, address);
  }

  let confirmationSent = false;
  if (input.email !== undefined && input.email !== r.email) {
    if (r.confirm_token) byConfirmToken.delete(r.confirm_token);
    r.email = input.email;
    r.email_verified = false;
    r.confirm_token = null;
    if (input.email) {
      r.confirm_token = token();
      byConfirmToken.set(r.confirm_token, address);
      await sendEmail({
        to: input.email,
        subject: "Confirm your Heliobond notifications",
        body:
          `Confirm you want Heliobond notifications for ${address}:\n` +
          `${baseUrl()}/v1/notifications/confirm?token=${r.confirm_token}\n\n` +
          `If this wasn't you, ignore this message.`,
      });
      confirmationSent = true;
    }
  }
  if (webhookUrl !== undefined) {
    if (webhookUrl && webhookUrl !== r.webhook_url) {
      r.webhook_secret = token();
      webhookSecret = r.webhook_secret;
    }
    r.webhook_url = webhookUrl;
  }
  if (input.events) r.events = [...new Set(input.events)];
  if (input.score_change_threshold !== undefined) {
    r.score_change_threshold = input.score_change_threshold;
  }
  if (input.project_ids) r.project_ids = [...new Set(input.project_ids)];
  r.updated_at = new Date().toISOString();

  return {
    preferences: publicView(r),
    webhook_secret: webhookSecret,
    confirmation_sent: confirmationSent,
  };
}

/** Complete double opt-in. Returns false for an unknown/used token. */
export function confirmEmail(confirmToken: string): boolean {
  const address = byConfirmToken.get(confirmToken);
  const r = address ? records.get(address) : undefined;
  if (!r) return false;
  r.email_verified = true;
  r.confirm_token = null;
  byConfirmToken.delete(confirmToken);
  return true;
}

/** One-click unsubscribe: removes email and webhook delivery, keeps the record disabled. */
export function unsubscribe(unsubscribeToken: string): boolean {
  const address = byUnsubscribeToken.get(unsubscribeToken);
  const r = address ? records.get(address) : undefined;
  if (!r) return false;
  r.events = [];
  r.email_verified = false;
  r.webhook_url = null;
  r.updated_at = new Date().toISOString();
  return true;
}

export function signPayload(body: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

function describe(e: NotificationEvent): { subject: string; text: string } {
  const d = e.data;
  switch (e.type) {
    case "yield_distributed":
      return {
        subject: "Yield distributed",
        text: `Yield of ${d.amount ?? "?"} was distributed to your position.`,
      };
    case "withdrawal_queued":
      return {
        subject: "Withdrawal queued",
        text: `Your withdrawal of ${d.amount ?? "?"} is queued until vault liquidity is restored.`,
      };
    case "withdrawal_claimable":
      return {
        subject: "Withdrawal ready to claim",
        text: `Your queued withdrawal of ${d.amount ?? "?"} is now claimable.`,
      };
    case "score_changed":
      return {
        subject: `Score change for project ${e.project_id}`,
        text: `Project ${e.project_id} moved: credit quality ${d.credit_quality_delta}, green impact ${d.green_impact_delta}.`,
      };
    case "creator_application_status":
      return {
        subject: `Creator application ${String(d.status ?? "updated")}`,
        text:
          `Your creator application ${String(d.application_id ?? "")} is now ` +
          `${String(d.status ?? "updated")}.`,
      };
  }
}

function wants(r: Record_, e: NotificationEvent): boolean {
  if (!r.events.includes(e.type)) return false;
  if (e.type !== "score_changed") return true;
  if (
    r.project_ids.length > 0 &&
    !(e.project_id !== undefined && r.project_ids.includes(e.project_id))
  ) {
    return false;
  }
  const cq = Math.abs(Number(e.data.credit_quality_delta ?? 0));
  const gi = Math.abs(Number(e.data.green_impact_delta ?? 0));
  return Math.max(cq, gi) >= r.score_change_threshold;
}

/** Returns true the first time a (event, channel, address) triple is seen. */
function firstDelivery(e: NotificationEvent, channel: string, address: string): boolean {
  const key = `${e.type}:${e.id}:${channel}:${address}`;
  if (delivered.has(key)) return false;
  delivered.add(key);
  return true;
}

export interface DispatchSummary {
  email: number;
  webhook: number;
}

/** Deliver one event to every matching address. Channel failures are isolated. */
export async function notify(e: NotificationEvent): Promise<DispatchSummary> {
  const summary: DispatchSummary = { email: 0, webhook: 0 };
  const targets = e.address
    ? [records.get(e.address)].filter((r): r is Record_ => !!r)
    : [...records.values()];
  const { subject, text } = describe(e);

  for (const r of targets) {
    if (!wants(r, e)) continue;

    if (r.email && r.email_verified && firstDelivery(e, "email", r.address)) {
      try {
        await sendEmail({
          to: r.email,
          subject: `[Heliobond] ${subject}`,
          body: `${text}\n\nUnsubscribe: ${baseUrl()}/v1/notifications/unsubscribe?token=${r.unsubscribe_token}`,
        });
        summary.email++;
      } catch (err) {
        delivered.delete(`${e.type}:${e.id}:email:${r.address}`);
        logger.error(`[notifications] email failed for ${r.address}`, logger.formatError(err));
      }
    }

    if (r.webhook_url && firstDelivery(e, "webhook", r.address)) {
      const url = r.webhook_url;
      const body = JSON.stringify({
        event: e.type,
        event_id: e.id,
        address: r.address,
        project_id: e.project_id,
        data: e.data,
        unsubscribe_url: `${baseUrl()}/v1/notifications/unsubscribe?token=${r.unsubscribe_token}`,
        timestamp: Date.now(),
      });
      try {
        await withRetry(
          async () => {
            await validatePublicUrl(url); // re-check at send time (DNS rebinding)
            const res = await fetch(url, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Heliobond-Signature": signPayload(body, r.webhook_secret),
              },
              body,
            });
            if (!res.ok) throw new Error(`webhook responded HTTP ${res.status}`);
          },
          { maxAttempts: 3, baseDelayMs: 500, label: "notification-webhook" },
        );
        summary.webhook++;
      } catch (err) {
        delivered.delete(`${e.type}:${e.id}:webhook:${r.address}`);
        logger.error(`[notifications] webhook failed for ${r.address}`, logger.formatError(err));
      }
    }
  }
  return summary;
}

export function resetNotifications(): void {
  records.clear();
  byUnsubscribeToken.clear();
  byConfirmToken.clear();
  delivered.clear();
}
