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
  BASE_FEE,
  nativeToScVal,
  StrKey,
} from "@stellar/stellar-sdk";
import { networkPassphrase } from "./stellar";

export type CreatorApplicationStatus = "submitted" | "in_review" | "approved" | "rejected";

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
  /** Pin `bytes` and return a content-addressed URI. Must not mutate bytes. */
  pin(bytes: Buffer): Promise<{ uri: string }>;
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
  async pin(bytes: Buffer): Promise<{ uri: string }> {
    return { uri: `ipfs://${sha256Hex(bytes)}` };
  }
}

/**
 * Provider hook for a real pinning service. Deliberately not wired in by
 * default: tests and local dev use the deterministic stub above. Supply a
 * `fetch`-compatible transport and endpoint, then `setMetadataPinner(new
 * HttpMetadataPinner(...))` at startup.
 */
export class HttpMetadataPinner implements MetadataPinner {
  constructor(
    private readonly endpoint: string,
    private readonly transport: typeof fetch = fetch,
  ) {}

  async pin(bytes: Buffer): Promise<{ uri: string }> {
    const res = await this.transport(this.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: bytes,
    });
    if (!res.ok) {
      throw new Error(`metadata pinning failed: HTTP ${res.status}`);
    }
    const body: unknown = await res.json();
    if (!isPlainRecord(body) || typeof body.uri !== "string" || !body.uri) {
      throw new Error("metadata pinning response did not include a uri");
    }
    return { uri: body.uri };
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

function validateDocumentUri(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new CreatorValidationError("documents entries must be non-empty strings");
  }
  const uri = raw.trim();
  if (uri.length > MAX_DOCUMENT_URI_LENGTH) {
    throw new CreatorValidationError(
      `document URIs must be no longer than ${MAX_DOCUMENT_URI_LENGTH} characters`,
    );
  }
  const match = SCHEME_RE.exec(uri);
  if (!match) {
    throw new CreatorValidationError(`document URI "${uri}" must include a scheme`);
  }
  const scheme = match[1].toLowerCase();
  if (!ALLOWED_URI_SCHEMES.includes(scheme)) {
    throw new CreatorValidationError(
      `document URI scheme "${scheme}" is not allowed (use ${ALLOWED_URI_SCHEMES.join(", ")})`,
    );
  }
  if (scheme === "https") {
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      throw new CreatorValidationError(`document URI "${uri}" is not a valid https URL`);
    }
    if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password) {
      throw new CreatorValidationError(`document URI "${uri}" is not a valid https URL`);
    }
  } else {
    const body = uri.slice(match[0].length).replace(/^\/\//, "");
    if (!body || /\s/.test(uri)) {
      throw new CreatorValidationError(`${scheme} URI must include a resource identifier`);
    }
  }
  return uri;
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

export function resetCreatorApplications(): void {
  applications.clear();
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

/** Find an approved application by its pinned metadata hash (indexer linking). */
export function findApplicationByMetadataHash(hash: string): CreatorApplication | undefined {
  if (!hash) return undefined;
  const normalized = hash.toLowerCase();
  for (const app of applications.values()) {
    if (app.metadata_hash?.toLowerCase() === normalized) return app;
  }
  return undefined;
}

/**
 * Move an application through the review workflow. Only `submitted →
 * in_review → approved|rejected` is allowed; every change appends an audit
 * entry. Approval pins the metadata and computes `metadata_hash` over the
 * exact pinned bytes.
 */
export async function reviewApplication(
  id: string,
  next: CreatorApplicationStatus,
  actor: string,
  note?: string,
): Promise<CreatorApplication> {
  const application = applications.get(id);
  if (!application) throw new CreatorApplicationNotFoundError(id);

  const allowed = TRANSITIONS[application.status];
  if (!allowed.includes(next)) {
    throw new CreatorValidationError(
      `cannot transition application from "${application.status}" to "${next}"`,
    );
  }

  if (next === "approved") {
    const { bytes, hash } = computeMetadataHash(application.metadata);
    const { uri } = await activePinner.pin(bytes);
    // The hash is always recomputed from the bytes we hand to the pinner, so
    // `verify_metadata_hash(bytes, hash)` holds for the exact pinned payload.
    application.metadata_hash = hash;
    application.metadata_uri = uri;
  }

  const now = new Date().toISOString();
  application.status = next;
  application.audit.push({
    from: application.audit.at(-1)?.to ?? null,
    to: next,
    at: now,
    actor,
    note,
  });
  application.updated_at = now;
  return application;
}

/** Indexer hook: link a confirmed `ProjectCreated` event to its application. */
export function linkProjectToApplication(params: {
  metadataHash: string;
  projectId: number;
  txHash: string;
  ledger: number;
}): CreatorApplication | null {
  const application = findApplicationByMetadataHash(params.metadataHash);
  if (!application) return null;
  if (application.project_id !== null) return application;
  if (application.status !== "approved") return null;

  application.project_id = params.projectId;
  application.linked_tx_hash = params.txHash;
  application.linked_at = new Date().toISOString();
  application.updated_at = application.linked_at;
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
 * Build an *unsigned* `set_whitelist(account, true)` transaction for the
 * whitelister to sign and submit. The whitelister's public address is the
 * source account; no secret key is used or stored.
 */
export function buildSetWhitelistTx(params: UnsignedTxParams & { account: string }): string {
  assertAccount(params.account, "account");
  return buildUnsigned(params, (contract) =>
    contract.call(
      "set_whitelist",
      Address.fromString(params.account).toScVal(),
      nativeToScVal(true, { type: "bool" }),
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
    maturityDate: number;
    metadataHash: string;
  },
): string {
  assertAccount(params.creator, "creator");
  if (typeof params.uri !== "string" || params.uri.length === 0) {
    throw new CreatorValidationError("uri must be a non-empty string");
  }
  if (!Number.isInteger(params.maturityDate) || params.maturityDate < 0) {
    throw new CreatorValidationError("maturityDate must be a non-negative integer (unix seconds)");
  }
  if (!/^[0-9a-fA-F]{64}$/.test(params.metadataHash)) {
    throw new CreatorValidationError("metadataHash must be a 32-byte sha256 hex string");
  }
  return buildUnsigned(params, (contract) =>
    contract.call(
      "create_project",
      Address.fromString(params.creator).toScVal(),
      nativeToScVal(params.uri, { type: "string" }),
      nativeToScVal(params.maturityDate, { type: "u64" }),
      nativeToScVal(Buffer.from(params.metadataHash, "hex"), { type: "bytes" }),
    ),
  );
}
