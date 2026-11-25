/**
 * Creator onboarding pipeline (#771).
 *
 * application → review → whitelist → metadata pinning → on-chain registration.
 *
 * This module is the pure/stateful core behind routes/creatorApplications:
 *  - validates the application metadata JSON (name, location, capacity_kw,
 *    documents) against the published schema in `src/schemas/`;
 *  - rejects unsupported/malformed document URIs *before* any on-chain work;
 *  - pins metadata through a pluggable provider and computes the sha256 hash
 *    over the exact pinned bytes (the hash `verify_metadata_hash` checks);
 *  - builds *unsigned* `set_whitelist` / `create_project` XDR for the
 *    whitelister / creator wallet to sign.
 *
 * The backend never holds a whitelister or creator secret key: every builder
 * here only ever needs a public address, and no function in this file signs.
 */
import { createHash, randomUUID } from "crypto";
import {
  Account,
  Address,
  Contract,
  TransactionBuilder,
  Transaction,
  Keypair,
  BASE_FEE,
  nativeToScVal,
  StrKey,
  rpc,
} from "@stellar/stellar-sdk";
import { networkPassphrase } from "./stellar";
import { config } from "../config";

export type CreatorApplicationStatus = "submitted" | "in_review" | "approved" | "rejected";
export type WhitelistConfirmationStatus = "unconfirmed" | "confirmed";

/** Document URI schemes accepted by the application schema. */
export const ALLOWED_URI_SCHEMES: readonly string[] = ["ipfs", "https", "ar"];

export const MAX_NAME_LENGTH = 255;
export const MAX_LOCATION_LENGTH = 255;
export const MAX_DOCUMENTS = 20;
export const MAX_DOCUMENT_URI_LENGTH = 2048;
export const MAX_CAPACITY_KW = 1_000_000_000;

const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

export class CreatorValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CreatorValidationError";
  }
}

/**
 * A review lost a race (#997): the application changed while this transition
 * was awaiting asynchronous work (metadata pinning), so it was not committed.
 */
export class CreatorConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CreatorConflictError";
  }
}

/**
 * The metadata pinning provider failed in a retryable way (#1001): it timed
 * out, the request was cancelled, or the transport failed. `code` is a
 * stable, machine-readable identifier so callers can tell a retryable
 * provider failure from a validation error: `metadata_pinning_timeout`,
 * `metadata_pinning_aborted` or `metadata_pinning_failed`.
 */
export class CreatorProviderError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CreatorProviderError";
    this.code = code;
  }
}

function pinCancelled(): CreatorProviderError {
  return new CreatorProviderError("metadata_pinning_aborted", "metadata pinning was cancelled");
}

/** Stop waiting even if a pluggable provider ignores its signal. */
async function waitForPin<T>(
  work: () => Promise<T>,
  signal?: AbortSignal,
  abortError: () => CreatorProviderError = pinCancelled,
): Promise<T> {
  if (!signal) return work();
  if (signal.aborted) throw abortError();
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const pending = Promise.resolve().then(() => {
      if (signal.aborted) throw abortError();
      return work();
    });
    return await Promise.race([pending, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** Default overall deadline for a metadata pinning request (#1001). */
export const DEFAULT_METADATA_PIN_TIMEOUT_MS = 30_000;

export class CreatorApplicationNotFoundError extends Error {
  constructor(id: string) {
    super(`Creator application ${id} not found`);
    this.name = "CreatorApplicationNotFoundError";
  }
}

/** The validated application payload — the published JSON schema mirrors this. */
export interface CreatorProjectMetadata {
  name: string;
  location: string;
  capacity_kw: number;
  documents: string[];
}

export interface StatusAuditEntry {
  from: CreatorApplicationStatus | null;
  to: CreatorApplicationStatus;
  at: string;
  actor: string;
  note?: string;
}

export interface CreatorApplication {
  id: string;
  wallet: string;
  status: CreatorApplicationStatus;
  metadata: CreatorProjectMetadata;
  /** sha256 (hex) over the exact pinned metadata bytes. Set on approval. */
  metadata_hash: string | null;
  /** Provider-returned content URI (e.g. ipfs://<cid>). Set on approval. */
  metadata_uri: string | null;
  /** Linked on-chain project id, filled in by the indexer after ProjectCreated. */
  project_id: number | null;
  linked_tx_hash: string | null;
  linked_at: string | null;
  audit: StatusAuditEntry[];
  created_at: string;
  updated_at: string;
  /** Separate whitelist confirmation status (#1004). */
  whitelist_status: WhitelistConfirmationStatus;
  /** True only after on-chain whitelisting has been confirmed (#1004). */
  whitelist_confirmed: boolean;
  whitelist_confirmed_at: string | null;
  whitelist_tx_hash: string | null;
  /** True only when approved, metadata pinned, AND whitelist is confirmed on-chain (#1004). */
  ready_for_registration: boolean;
}

// ── Canonical serialisation + hashing ────────────────────────────────────────

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deterministic, key-sorted clone so the same metadata always hashes equally. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  if (isPlainRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalize(value[key]);
    }
    return out;
  }
  return value;
}

/** The exact bytes that get pinned and hashed. */
export function canonicalMetadataBytes(metadata: CreatorProjectMetadata): Buffer {
  return Buffer.from(JSON.stringify(canonicalize(metadata)), "utf8");
}

export function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface MetadataHashResult {
  canonical: string;
  bytes: Buffer;
  hash: string;
}

/** sha256 of the canonical metadata bytes. */
export function computeMetadataHash(metadata: CreatorProjectMetadata): MetadataHashResult {
  const bytes = canonicalMetadataBytes(metadata);
  return { canonical: bytes.toString("utf8"), bytes, hash: sha256Hex(bytes) };
}

/**
 * Off-chain mirror of the contract's `verify_metadata_hash`: true when `hash`
 * is the sha256 of `bytes`.
 */
export function verifyMetadataHash(bytes: Buffer, hash: string): boolean {
  if (hash.length !== 64) return false;
  return sha256Hex(bytes) === hash.toLowerCase();
}

// ── Metadata pinning (pluggable provider) ────────────────────────────────────

export interface MetadataPinner {
  /**
   * Pin `bytes` and return a content-addressed URI. Must not mutate bytes.
   * `options.signal` cancels the request (#1001); a pinner that never
   * settles must still respect it.
   */
  pin(bytes: Buffer, options?: { signal?: AbortSignal }): Promise<{ uri: string }>;
}

/**
 * Default provider: a deterministic local stub used in tests and when no IPFS
 * provider is configured. It never touches the network and addresses the
 * content by its sha256, so the returned URI is stable for a given payload.
 *
 * A production deployment overrides this with a real provider via
 * `setMetadataPinner` (e.g. an HTTP pinning service) — see `HttpMetadataPinner`
 * below for the provider hook.
 */
class DeterministicMetadataPinner implements MetadataPinner {
  async pin(bytes: Buffer, options?: { signal?: AbortSignal }): Promise<{ uri: string }> {
    // #1001: cancellation still propagates even though this pinner never
    // touches the network, so a cancelled review never commits.
    if (options?.signal?.aborted) {
      throw pinCancelled();
    }
    return { uri: `ipfs://${sha256Hex(bytes)}` };
  }
}

/**
 * Provider hook for a real pinning service. Deliberately not wired in by
 * default: tests and local dev use the deterministic stub above. Supply a
 * `fetch`-compatible transport and endpoint, then `setMetadataPinner(new
 * HttpMetadataPinner(...))` at startup.
 *
 * #1001: every request is bounded by an overall deadline (`timeoutMs`,
 * default 30s) and honours a caller `AbortSignal`. A stalled transport
 * terminates with a stable, retryable `CreatorProviderError` instead of
 * hanging the approval request.
 */
export class HttpMetadataPinner implements MetadataPinner {
  constructor(
    private readonly endpoint: string,
    private readonly transport: typeof fetch = fetch,
    private readonly timeoutMs: number = DEFAULT_METADATA_PIN_TIMEOUT_MS,
  ) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
      throw new RangeError("metadata pinning timeout must be a positive timer duration");
    }
  }

  async pin(bytes: Buffer, options?: { signal?: AbortSignal }): Promise<{ uri: string }> {
    const signal = options?.signal;
    if (signal?.aborted) throw pinCancelled();
    const controller = new AbortController();
    const onCallerAbort = () => controller.abort(pinCancelled());
    signal?.addEventListener("abort", onCallerAbort, { once: true });
    const timer = setTimeout(() => {
      controller.abort(
        new CreatorProviderError(
          "metadata_pinning_timeout",
          `metadata pinning timed out after ${this.timeoutMs}ms`,
        ),
      );
    }, this.timeoutMs);
    try {
      return await waitForPin(
        async () => {
          const res = await this.transport(this.endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream" },
            body: bytes,
            signal: controller.signal,
          });
          if (!res.ok) {
            throw new CreatorProviderError(
              "metadata_pinning_failed",
              `metadata pinning failed: HTTP ${res.status}`,
            );
          }
          const body: unknown = await res.json();
          if (!isPlainRecord(body) || typeof body.uri !== "string" || !body.uri) {
            throw new CreatorProviderError(
              "metadata_pinning_failed",
              "metadata pinning response did not include a uri",
            );
          }
          return { uri: validateMetadataUri(body.uri) };
        },
        controller.signal,
        () => controller.signal.reason as CreatorProviderError,
      );
    } catch (err) {
      if (err instanceof CreatorProviderError) throw err;
      if (err instanceof CreatorValidationError) throw err;
      throw new CreatorProviderError(
        "metadata_pinning_failed",
        "metadata pinning transport failed",
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onCallerAbort);
    }
  }
}

const defaultPinner: MetadataPinner = new DeterministicMetadataPinner();
let activePinner: MetadataPinner = defaultPinner;

export function setMetadataPinner(pinner: MetadataPinner | null): void {
  activePinner = pinner ?? defaultPinner;
}

export function getMetadataPinner(): MetadataPinner {
  return activePinner;
}

// ── Validation ───────────────────────────────────────────────────────────────

/**
 * The supported URI and length constraints shared by application document
 * URIs and provider-returned metadata URIs (#1000): a scheme from
 * ALLOWED_URI_SCHEMES, no longer than MAX_DOCUMENT_URI_LENGTH, and for
 * https a valid URL with a hostname and no embedded credentials.
 */
function validateSupportedUri(uri: string, label: string): string {
  if (uri.length > MAX_DOCUMENT_URI_LENGTH) {
    throw new CreatorValidationError(
      `${label}s must be no longer than ${MAX_DOCUMENT_URI_LENGTH} characters`,
    );
  }
  const match = SCHEME_RE.exec(uri);
  if (!match) {
    throw new CreatorValidationError(`${label} must include a scheme`);
  }
  const scheme = match[1].toLowerCase();
  if (!ALLOWED_URI_SCHEMES.includes(scheme)) {
    throw new CreatorValidationError(
      `${label} scheme "${scheme}" is not allowed (use ${ALLOWED_URI_SCHEMES.join(", ")})`,
    );
  }
  if (scheme === "https") {
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      throw new CreatorValidationError(`${label} is not a valid https URL`);
    }
    if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password) {
      throw new CreatorValidationError(`${label} is not a valid https URL`);
    }
  } else {
    const body = uri.slice(match[0].length).replace(/^\/\//, "");
    if (!body || /\s/.test(uri)) {
      throw new CreatorValidationError(`${scheme} URI must include a resource identifier`);
    }
  }
  return uri;
}

function validateDocumentUri(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new CreatorValidationError("documents entries must be non-empty strings");
  }
  return validateSupportedUri(raw.trim(), "document URI");
}

/**
 * Validate a URI returned by a metadata pinning provider (#1000). Applies the
 * same supported URI and length constraints as document URIs, so a malformed,
 * unsupported or oversized provider URI is rejected before any application
 * state changes.
 */
export function validateMetadataUri(raw: unknown): string {
  if (typeof raw !== "string" || /[\s\p{Cc}\\]/u.test(raw)) {
    throw new CreatorValidationError("metadata URI contains invalid characters");
  }
  validateSupportedUri(raw, "metadata URI");
  // ProjectRegistry's create_project validates the prefix and UTF-8 byte length.
  const length = Buffer.byteLength(raw);
  if (length < 8 || length > 512 || !/^(ipfs|https|ar):\/\/[^/?#]/.test(raw)) {
    throw new CreatorValidationError(
      "metadata URI must use a registry-supported prefix and 8–512 bytes",
    );
  }
  return raw;
}

/** Validate and normalise an untrusted application metadata payload. */
export function validateApplicationMetadata(input: unknown): CreatorProjectMetadata {
  if (!isPlainRecord(input)) {
    throw new CreatorValidationError("metadata must be a JSON object");
  }

  const name = input.name;
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new CreatorValidationError("name must be a non-empty string");
  }
  if (name.trim().length > MAX_NAME_LENGTH) {
    throw new CreatorValidationError(`name must be no longer than ${MAX_NAME_LENGTH} characters`);
  }

  const location = input.location;
  if (typeof location !== "string" || location.trim().length === 0) {
    throw new CreatorValidationError("location must be a non-empty string");
  }
  if (location.trim().length > MAX_LOCATION_LENGTH) {
    throw new CreatorValidationError(
      `location must be no longer than ${MAX_LOCATION_LENGTH} characters`,
    );
  }

  const capacity = input.capacity_kw;
  if (typeof capacity !== "number" || !Number.isFinite(capacity) || capacity <= 0) {
    throw new CreatorValidationError("capacity_kw must be a positive number");
  }
  if (capacity > MAX_CAPACITY_KW) {
    throw new CreatorValidationError(`capacity_kw must not exceed ${MAX_CAPACITY_KW}`);
  }

  const documents = input.documents;
  if (!Array.isArray(documents) || documents.length === 0) {
    throw new CreatorValidationError("documents must be a non-empty array of URIs");
  }
  if (documents.length > MAX_DOCUMENTS) {
    throw new CreatorValidationError(
      `documents must contain no more than ${MAX_DOCUMENTS} entries`,
    );
  }

  return {
    name: name.trim(),
    location: location.trim(),
    capacity_kw: capacity,
    documents: documents.map((entry) => validateDocumentUri(entry)),
  };
}

// ── Store + review workflow ──────────────────────────────────────────────────

const TRANSITIONS: Record<CreatorApplicationStatus, readonly CreatorApplicationStatus[]> = {
  submitted: ["in_review"],
  in_review: ["approved", "rejected"],
  approved: [],
  rejected: [],
};

const applications = new Map<string, CreatorApplication>();

/**
 * Per-application status revision (#997). Bumped on every committed status
 * transition; a review that awaited the pinner only commits when the revision
 * it started from is still current. Kept out of the public application shape.
 */
const revisions = new Map<string, number>();

function currentRevision(id: string): number {
  return revisions.get(id) ?? 0;
}

export type RegistryWhitelistChecker = (contractId: string, wallet: string) => Promise<boolean>;

let activeWhitelistChecker: RegistryWhitelistChecker = async () => false;

export function setRegistryWhitelistChecker(checker: RegistryWhitelistChecker | null): void {
  activeWhitelistChecker = checker ?? (async () => false);
}

export function getRegistryWhitelistChecker(): RegistryWhitelistChecker {
  return activeWhitelistChecker;
}

export function isReadyForRegistration(app: CreatorApplication): boolean {
  return (
    app.status === "approved" &&
    Boolean(app.metadata_hash) &&
    Boolean(app.metadata_uri) &&
    app.whitelist_confirmed === true
  );
}

export function resetCreatorApplications(): void {
  applications.clear();
  revisions.clear();
  activeWhitelistChecker = async () => false;
}

export function submitApplication(wallet: string, input: unknown): CreatorApplication {
  const metadata = validateApplicationMetadata(input);
  const now = new Date().toISOString();
  const application: CreatorApplication = {
    id: randomUUID(),
    wallet,
    status: "submitted",
    metadata,
    metadata_hash: null,
    metadata_uri: null,
    project_id: null,
    linked_tx_hash: null,
    linked_at: null,
    audit: [{ from: null, to: "submitted", at: now, actor: wallet }],
    created_at: now,
    updated_at: now,
    whitelist_status: "unconfirmed",
    whitelist_confirmed: false,
    whitelist_confirmed_at: null,
    whitelist_tx_hash: null,
    ready_for_registration: false,
  };
  applications.set(application.id, application);
  return application;
}

export function getApplication(id: string): CreatorApplication | undefined {
  return applications.get(id);
}

export function listApplications(): CreatorApplication[] {
  return Array.from(applications.values());
}

/**
 * Find an application by its pinned metadata hash. Identical metadata from
 * different wallets hashes equally, so this is ambiguous on its own — project
 * linking uses `findApplicationsForProject` with the creator as well (#998).
 */
export function findApplicationByMetadataHash(hash: string): CreatorApplication | undefined {
  return findApplicationsByMetadataHash(hash)[0];
}

/**
 * All applications whose pinned metadata hash equals `hash`, in submission
 * order (the store is insertion-ordered, which is exact even when two
 * submissions share a millisecond timestamp).
 */
export function findApplicationsByMetadataHash(hash: string): CreatorApplication[] {
  if (!hash) return [];
  const normalized = hash.toLowerCase();
  return Array.from(applications.values()).filter(
    (app) => app.metadata_hash?.toLowerCase() === normalized,
  );
}

/**
 * Applications that a `ProjectCreated(project_id, owner)` event could belong
 * to: the pinned metadata hash matches AND the application was submitted by
 * the wallet that created the project on-chain (#998). Oldest first.
 */
export function findApplicationsForProject(
  metadataHash: string,
  creator: string,
): CreatorApplication[] {
  if (!creator) return [];
  return findApplicationsByMetadataHash(metadataHash).filter((app) => app.wallet === creator);
}

/**
 * Move an application through the review workflow. Only `submitted →
 * in_review → approved|rejected` is allowed; every change appends an audit
 * entry. Approval pins the metadata and computes `metadata_hash` over the
 * exact pinned bytes.
 *
 * #1001: `options.signal` cancels a pending pin. A cancelled or timed-out pin
 * throws before the commit below, so status, hash, URI and audit history
 * are left exactly as they were.
 */
export async function reviewApplication(
  id: string,
  next: CreatorApplicationStatus,
  actor: string,
  note?: string,
  options?: { signal?: AbortSignal },
): Promise<CreatorApplication> {
  const application = applications.get(id);
  if (!application) throw new CreatorApplicationNotFoundError(id);

  assertTransitionAllowed(application, next);
  const startRevision = currentRevision(id);

  let pinned: { hash: string; uri: string } | null = null;
  if (next === "approved") {
    const { bytes, hash } = computeMetadataHash(application.metadata);
    const { uri } = await waitForPin(
      () => activePinner.pin(bytes, { signal: options?.signal }),
      options?.signal,
    );
    if (options?.signal?.aborted) throw pinCancelled();
    // #1000: validate the provider URI before anything is committed, so a
    // pluggable pinner returning a malformed, unsupported or oversized URI
    // leaves the application in_review instead of storing it as approved.
    const validatedUri = validateMetadataUri(uri);
    // The hash is always recomputed from the bytes we hand to the pinner, so
    // `verify_metadata_hash(bytes, hash)` holds for the exact pinned payload.
    pinned = { hash, uri: validatedUri };
  }

  // #997: another review may have committed while we awaited the pinner.
  // Only a transition based on the state we validated may commit; the loser
  // must not overwrite pinned metadata or append an impossible audit entry.
  if (currentRevision(id) !== startRevision) {
    throw new CreatorConflictError(
      `application ${id} changed to "${application.status}" while this review was in progress; ` +
        `"${next}" was not applied`,
    );
  }
  assertTransitionAllowed(application, next);

  if (pinned) {
    application.metadata_hash = pinned.hash;
    application.metadata_uri = pinned.uri;
  }
  const now = new Date().toISOString();
  const from = application.status;
  application.status = next;
  revisions.set(id, startRevision + 1);
  application.ready_for_registration = isReadyForRegistration(application);
  application.audit.push({ from, to: next, at: now, actor, note });
  application.updated_at = now;
  return application;
}

function assertTransitionAllowed(
  application: CreatorApplication,
  next: CreatorApplicationStatus,
): void {
  if (!TRANSITIONS[application.status].includes(next)) {
    throw new CreatorValidationError(
      `cannot transition application from "${application.status}" to "${next}"`,
    );
  }
}

export interface ConfirmWhitelistParams {
  txHash?: string;
  ledger?: number;
  confirmedAt?: string;
  actor?: string;
  note?: string;
}

/**
 * Confirm on-chain whitelisting for an application (#1004).
 * Updates whitelist confirmation state and makes registration readiness observable
 * without requiring a second application review.
 */
export function confirmWhitelistForApplication(
  id: string,
  params?: ConfirmWhitelistParams,
): CreatorApplication {
  const application = applications.get(id);
  if (!application) throw new CreatorApplicationNotFoundError(id);

  const now = params?.confirmedAt ?? new Date().toISOString();
  application.whitelist_status = "confirmed";
  application.whitelist_confirmed = true;
  application.whitelist_confirmed_at = now;
  if (params?.txHash) {
    application.whitelist_tx_hash = params.txHash;
  }
  application.ready_for_registration = isReadyForRegistration(application);
  application.audit.push({
    from: application.status,
    to: application.status,
    at: now,
    actor: params?.actor ?? "whitelist_confirmation",
    note:
      params?.note ??
      (params?.txHash
        ? `Whitelist confirmed on-chain in tx ${params.txHash}`
        : "Whitelist confirmed on-chain"),
  });
  application.updated_at = now;
  return application;
}

/**
 * Confirm on-chain whitelisting for all applications belonging to a wallet (#1004).
 */
export function confirmWhitelistForWallet(
  wallet: string,
  params?: ConfirmWhitelistParams,
): CreatorApplication[] {
  const matched: CreatorApplication[] = [];
  for (const app of applications.values()) {
    if (app.wallet === wallet) {
      confirmWhitelistForApplication(app.id, params);
      matched.push(app);
    }
  }
  return matched;
}

/**
 * Reconcile application whitelisting status against on-chain registry state (#1004).
 */
export async function reconcileApplicationWhitelist(
  id: string,
  checker?: RegistryWhitelistChecker,
): Promise<CreatorApplication> {
  const application = applications.get(id);
  if (!application) throw new CreatorApplicationNotFoundError(id);

  if (application.whitelist_confirmed) {
    return application;
  }

  const checkFn = checker ?? activeWhitelistChecker;
  const contractId = config.PROJECT_REGISTRY_CONTRACT_ID;
  const isWhitelisted = await checkFn(contractId, application.wallet);
  if (isWhitelisted) {
    return confirmWhitelistForApplication(id, {
      actor: "registry_reconciliation",
      note: "Whitelisting verified against on-chain registry state",
    });
  }
  return application;
}

/**
 * Indexer hook: link a confirmed `ProjectCreated` event to its application.
 *
 * Matching uses both metadata identity and creator ownership (#998): two
 * wallets may submit identical metadata, so the hash alone cannot tell their
 * applications apart. Among one creator's matching applications:
 *  - replay: an application already linked to `projectId` is returned as-is
 *    (no relinking, no new audit entry);
 *  - several approved, unlinked submissions with the same metadata are linked
 *    deterministically in submission order (oldest first), one per project;
 *  - applications already linked to a different project are never relinked.
 * Returns null when no application can be linked.
 */
export function linkProjectToApplication(params: {
  metadataHash: string;
  creator: string;
  projectId: number;
  txHash: string;
  ledger: number;
}): CreatorApplication | null {
  const candidates = findApplicationsForProject(params.metadataHash, params.creator);
  if (candidates.length === 0) return null;

  const alreadyLinked = candidates.find((app) => app.project_id === params.projectId);
  if (alreadyLinked) return alreadyLinked;

  const application = candidates.find(
    (app) => app.status === "approved" && app.project_id === null,
  );
  if (!application) return null;

  const now = new Date().toISOString();
  application.project_id = params.projectId;
  application.linked_tx_hash = params.txHash;
  application.linked_at = now;
  application.updated_at = now;
  application.audit.push({
    from: application.status,
    to: application.status,
    at: now,
    actor: "indexer",
    note: `Linked to on-chain project ${params.projectId} in tx ${params.txHash} (ledger ${params.ledger})`,
  });
  return application;
}

// ── Unsigned XDR builders (never sign server-side) ───────────────────────────

export interface UnsignedTxParams {
  /** Soroban contract id (C...). */
  contractId: string;
  /** Transaction source account (G...). Only a public key is ever needed. */
  sourceAccount: string;
  /** Current account sequence number as a decimal string. */
  sequence: string;
  /** Optional timebound in seconds (0 = none). */
  timeoutSeconds?: number;
}

/** Largest value a Soroban `u64` argument can hold. */
export const U64_MAX = 18_446_744_073_709_551_615n;

/**
 * `valid_until` for a permanent whitelist entry. The registry treats
 * `valid_until == 0` as "never expires" (see `create_project`'s expiry check),
 * so this is the default when no expiry is supplied (#995).
 */
export const PERMANENT_WHITELIST_VALID_UNTIL = 0n;

/** Input accepted for a `u64` argument: bigint, decimal string or safe integer. */
export type U64Input = bigint | string | number;

/**
 * Exactly convert a `u64` input to bigint (#996). Decimal strings and bigints
 * are carried through without precision loss; JS numbers are only accepted
 * when they are safe integers, because anything above
 * `Number.MAX_SAFE_INTEGER` may already have been rounded.
 */
export function parseU64(value: U64Input, field: string): bigint {
  let parsed: bigint;
  if (typeof value === "bigint") {
    parsed = value;
  } else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new CreatorValidationError(
        `${field} must be a safe integer when passed as a number; pass a decimal string for larger values`,
      );
    }
    parsed = BigInt(value);
  } else if (typeof value === "string" && /^\d+$/.test(value)) {
    parsed = BigInt(value);
  } else {
    throw new CreatorValidationError(`${field} must be a non-negative integer`);
  }
  if (parsed < 0n || parsed > U64_MAX) {
    throw new CreatorValidationError(`${field} must be between 0 and ${U64_MAX} (u64)`);
  }
  return parsed;
}

function assertContractId(contractId: string): void {
  if (!StrKey.isValidContract(contractId)) {
    throw new CreatorValidationError("contractId must be a valid Stellar contract id (C...)");
  }
}

function assertAccount(address: string, field: string): void {
  if (!StrKey.isValidEd25519PublicKey(address)) {
    throw new CreatorValidationError(`${field} must be a valid Stellar account address (G...)`);
  }
}

function buildUnsigned(
  params: UnsignedTxParams,
  buildOperation: (contract: Contract) => ReturnType<Contract["call"]>,
): string {
  assertContractId(params.contractId);
  assertAccount(params.sourceAccount, "sourceAccount");
  const source = new Account(params.sourceAccount, params.sequence);
  const contract = new Contract(params.contractId);
  const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase })
    .addOperation(buildOperation(contract))
    .setTimeout(params.timeoutSeconds ?? 0)
    .build();
  return tx.toXDR();
}

/**
 * Build an *unsigned* `set_whitelist(account, status, valid_until)`
 * transaction for the whitelister to sign and submit, matching the registry
 * signature `set_whitelist(account: Address, status: bool, valid_until: u64)`
 * (#995). The whitelister's public address is the source account; no secret
 * key is used or stored.
 *
 * - `status` defaults to `true` (whitelist the account).
 * - `validUntil` is a unix timestamp in seconds after which the entry expires;
 *   it defaults to `PERMANENT_WHITELIST_VALID_UNTIL` (`0`, never expires).
 */
export function buildSetWhitelistTx(
  params: UnsignedTxParams & { account: string; status?: boolean; validUntil?: U64Input },
): string {
  assertAccount(params.account, "account");
  const status = params.status ?? true;
  if (typeof status !== "boolean") {
    throw new CreatorValidationError("status must be a boolean");
  }
  const validUntil = parseU64(params.validUntil ?? PERMANENT_WHITELIST_VALID_UNTIL, "validUntil");
  return buildUnsigned(params, (contract) =>
    contract.call(
      "set_whitelist",
      Address.fromString(params.account).toScVal(),
      nativeToScVal(status, { type: "bool" }),
      nativeToScVal(validUntil, { type: "u64" }),
    ),
  );
}

/**
 * Build an *unsigned* `create_project(creator, uri, maturity_date,
 * metadata_hash)` transaction for the creator's wallet to sign and submit.
 */
export function buildCreateProjectTx(
  params: UnsignedTxParams & {
    creator: string;
    uri: string;
    /** Unix seconds as bigint, decimal string or safe integer (#996). */
    maturityDate: U64Input;
    metadataHash: string;
  },
): string {
  assertAccount(params.creator, "creator");
  if (typeof params.uri !== "string" || params.uri.length === 0) {
    throw new CreatorValidationError("uri must be a non-empty string");
  }
  const maturityDate = parseU64(params.maturityDate, "maturityDate");
  if (!/^[0-9a-fA-F]{64}$/.test(params.metadataHash)) {
    throw new CreatorValidationError("metadataHash must be a 32-byte sha256 hex string");
  }
  return buildUnsigned(params, (contract) =>
    contract.call(
      "create_project",
      Address.fromString(params.creator).toScVal(),
      nativeToScVal(params.uri, { type: "string" }),
      nativeToScVal(maturityDate, { type: "u64" }),
      nativeToScVal(Buffer.from(params.metadataHash, "hex"), { type: "bytes" }),
    ),
  );
}

// ── Transaction preparation contract & client pipeline (#1005) ─────────────

export interface OnboardingTxPreparationContract {
  prepared: boolean;
  simulation_required: boolean;
  resource_assembly_required: boolean;
  authorization_required: boolean;
  signing_required: boolean;
  steps: readonly [
    "simulateTransaction",
    "assembleTransaction",
    "signTransaction",
    "sendTransaction",
  ];
  instructions: string;
}

/**
 * Published preparation contract for unsigned onboarding transactions (#1005).
 * States explicitly that BASE_FEE transactions must be simulated via Soroban RPC
 * and assembled with required resources and authorization footprint before signing.
 */
export const ONBOARDING_TX_PREPARATION_CONTRACT: OnboardingTxPreparationContract = Object.freeze({
  prepared: false,
  simulation_required: true,
  resource_assembly_required: true,
  authorization_required: true,
  signing_required: true,
  steps: [
    "simulateTransaction",
    "assembleTransaction",
    "signTransaction",
    "sendTransaction",
  ] as const,
  instructions:
    "This transaction is unsigned and unprepared. Before signing, the wallet or client must simulate the transaction via Soroban RPC (simulateTransaction) and assemble the authorization footprint and resource fees (assembleTransaction or prepareTransaction), sign with the source account secret key, and submit via sendTransaction.",
});

/**
 * Prepares an unsigned Soroban onboarding transaction by running it through
 * read-only simulation and resource assembly (#1005).
 */
export async function prepareOnboardingTransaction(
  unsignedXdr: string,
  server: {
    simulateTransaction: (tx: Transaction) => Promise<rpc.Api.SimulateTransactionResponse>;
    prepareTransaction?: (tx: Transaction) => Promise<Transaction>;
  },
): Promise<string> {
  const tx = TransactionBuilder.fromXDR(unsignedXdr, networkPassphrase);
  if (!(tx instanceof Transaction)) {
    throw new Error("expected a plain transaction");
  }
  if (server.prepareTransaction) {
    const prepared = await server.prepareTransaction(tx);
    return prepared.toXDR();
  }
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`Transaction simulation failed: ${sim.error}`);
  }
  const assembled = rpc.assembleTransaction(tx, sim).build();
  return assembled.toXDR();
}

export interface ClientExecutionStepResult {
  step: "simulate" | "assemble" | "sign" | "submit";
  status: "success" | "failure";
  detail?: unknown;
}

export interface ClientExecutionResult {
  simulated: boolean;
  prepared_xdr: string;
  signed_xdr: string;
  submission_tx_hash: string;
  steps: ClientExecutionStepResult[];
}

/**
 * Client execution pipeline helper taking an unsigned onboarding transaction through
 * preparation (simulation and resource assembly), signing, and submission (#1005).
 */
export async function executeClientOnboardingTransaction(params: {
  unsignedXdr: string;
  signerKeypair: Keypair;
  rpcServer: {
    simulateTransaction: (tx: Transaction) => Promise<rpc.Api.SimulateTransactionResponse>;
    prepareTransaction?: (tx: Transaction) => Promise<Transaction>;
    sendTransaction: (tx: Transaction) => Promise<{ status: string; hash: string }>;
  };
}): Promise<ClientExecutionResult> {
  const steps: ClientExecutionStepResult[] = [];
  const parsed = TransactionBuilder.fromXDR(params.unsignedXdr, networkPassphrase);
  if (!(parsed instanceof Transaction)) {
    throw new Error("expected a plain transaction");
  }

  // 1. Simulate & Assemble
  let assembledTx: Transaction;
  if (params.rpcServer.prepareTransaction) {
    assembledTx = await params.rpcServer.prepareTransaction(parsed);
    steps.push({ step: "simulate", status: "success" });
    steps.push({ step: "assemble", status: "success" });
  } else {
    const sim = await params.rpcServer.simulateTransaction(parsed);
    if (rpc.Api.isSimulationError(sim)) {
      steps.push({ step: "simulate", status: "failure", detail: sim.error });
      throw new Error(`Transaction simulation failed: ${sim.error}`);
    }
    steps.push({ step: "simulate", status: "success" });

    assembledTx = rpc.assembleTransaction(parsed, sim).build();
    steps.push({ step: "assemble", status: "success" });
  }

  const preparedXdr = assembledTx.toXDR();

  // 2. Sign
  assembledTx.sign(params.signerKeypair as any);
  const signedXdr = assembledTx.toXDR();
  steps.push({ step: "sign", status: "success" });

  // 3. Submit
  const sendRes = await params.rpcServer.sendTransaction(assembledTx);
  steps.push({ step: "submit", status: "success", detail: sendRes });

  return {
    simulated: true,
    prepared_xdr: preparedXdr,
    signed_xdr: signedXdr,
    submission_tx_hash: sendRes.hash,
    steps,
  };
}
