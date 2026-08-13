/**
 * Pure submission logic — validation, normalisation, and the R2 key scheme.
 *
 * Deliberately free of Worker globals (no `env`, no bindings, no `Request`) so
 * every rule here is unit-testable in isolation and the request handler in
 * `index.ts` stays a thin shell around it.
 */

/**
 * The one discriminator the app sends. A single `POST /api/submit` endpoint
 * serves all four in-app surfaces; `kind` says which one, and it is the first
 * path segment of the stored object so the founder can browse one channel at a
 * time in the R2 dashboard.
 */
export const SUBMISSION_KINDS = [
  "feedback",
  "book_request",
  "word_report",
  "waitlist",
] as const;

export type SubmissionKind = (typeof SUBMISSION_KINDS)[number];

/**
 * Hard cap on the REQUEST BODY, in bytes. Enforced twice in `index.ts`: once on
 * the declared `Content-Length` (cheap, before we read anything) and once on the
 * bytes actually read (a client can under-declare or omit the header). 8 KB is
 * ~4x the largest realistic submission — a long paragraph of feedback plus the
 * word-report context — so it never bites a real user, but it caps what an
 * abusive client can push into the bucket per accepted request.
 */
export const MAX_BODY_BYTES = 8 * 1024;

/** Per-field limits. Validation REJECTS rather than truncates: silently storing
 *  half of what someone wrote is worse than telling the client it was too long
 *  (and the app enforces the same limits in its own editor, so a real user never
 *  reaches these). */
export const LIMITS = {
  id: 64,
  message: 4000,
  email: 254,
  contextEntries: 12,
  contextKey: 40,
  contextValue: 300,
  appEntries: 8,
  appKey: 40,
  appValue: 40,
} as const;

// ⚠️ MIRRORED IN THE APP. `SubmissionLimits` in
// `logia/Logia/Domain/Submission.swift` must stay a SUBSET of these limits, and
// must count the same way (`message` is measured in UTF-16 units on both sides —
// see the note on the message check below). If you change a number here, change
// it there, or the app will cheerfully send bodies this endpoint rejects.
// `LogiaTests/SubmissionTests.testClientLimitsMatchTheWorkerLimits` pins the pair.

/** What the app sends. Everything except `kind` and `id` is optional so a new
 *  client field can be added without a Worker deploy. */
export interface SubmissionInput {
  id: string;
  kind: SubmissionKind;
  message?: string;
  email?: string;
  context?: Record<string, string>;
  app?: Record<string, string>;
  createdAt?: string;
}

/** The stored object: exactly what the client sent, plus a server-observed
 *  envelope. `ip` is deliberately absent — see `ipHash`. */
export interface StoredSubmission extends SubmissionInput {
  receivedAt: string;
  country: string | null;
  /** Salted SHA-256 of the client IP, truncated. NEVER the raw address: with a
   *  32-bit IPv4 space an UNSALTED hash is trivially reversible, so the salt is
   *  a required secret (`IP_HASH_SALT`) and the Worker refuses to run without
   *  it. Enough to spot one abusive source across submissions; not enough to
   *  recover who it was. */
  ipHash: string;
}

export type ValidationResult =
  | { ok: true; value: SubmissionInput }
  | { ok: false; error: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Trim, and collapse an empty string to `undefined` so "" and "absent" behave
 *  identically downstream. */
function trimmed(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length === 0 ? undefined : t;
}

/**
 * Validate + normalise a decoded JSON body into a `SubmissionInput`.
 *
 * Rules that matter:
 *  - `kind` must be one of the four known values (an unknown kind would create
 *    an unbrowsable key prefix in the bucket).
 *  - `id` is client-generated and carried through so a retry of the SAME
 *    submission is recognisable in the bucket (it lands in the key's hash
 *    suffix and in the object's `submissionId` metadata).
 *  - Every kind needs SOMETHING actionable: a message, or (for the waitlist) an
 *    email. An empty submission is a bug or a probe, never a user.
 */
export function validateSubmission(body: unknown): ValidationResult {
  if (!isPlainObject(body)) return { ok: false, error: "body must be a JSON object" };

  const kind = trimmed(body.kind);
  if (!kind || !(SUBMISSION_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, error: "unknown kind" };
  }

  const id = trimmed(body.id);
  if (!id) return { ok: false, error: "missing id" };
  if (id.length > LIMITS.id) return { ok: false, error: "id too long" };
  // Keeps the id safe to embed in a hash input and in object metadata, and
  // stops anything path-shaped from reaching the key builder.
  if (!/^[A-Za-z0-9._:-]+$/.test(id)) return { ok: false, error: "malformed id" };

  if (body.message !== undefined && typeof body.message !== "string") {
    return { ok: false, error: "message must be a string" };
  }
  const message = trimmed(body.message);
  // `.length` is UTF-16 code units. The APP counts the same way
  // (`message.utf16.count`) — NOT grapheme clusters, which would let a decomposed
  // "é" (e + U+0301) count as one client-side and two here, so a legal-looking
  // message would 400 after the user had already been told it was fine.
  if (message && message.length > LIMITS.message) {
    return { ok: false, error: "message too long" };
  }

  const email = trimmed(body.email);
  if (email) {
    if (email.length > LIMITS.email) return { ok: false, error: "email too long" };
    // Deliberately loose: the only thing a stricter regex buys is rejecting
    // addresses that are actually valid. A typo'd address is the user's to fix.
    if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) {
      return { ok: false, error: "malformed email" };
    }
  }

  if (kind === "waitlist" && !email) {
    return { ok: false, error: "waitlist needs an email" };
  }
  if (kind !== "waitlist" && !message) {
    return { ok: false, error: "message is required" };
  }

  let context: Record<string, string> | undefined;
  if (body.context !== undefined) {
    if (!isPlainObject(body.context)) return { ok: false, error: "context must be an object" };
    const entries = Object.entries(body.context);
    if (entries.length > LIMITS.contextEntries) {
      return { ok: false, error: "too many context entries" };
    }
    // Null-prototype: a submitted key of "__proto__" or "constructor" must be
    // ordinary data, not something that mutates the object it lands in.
    context = Object.create(null) as Record<string, string>;
    for (const [k, v] of entries) {
      if (k.length > LIMITS.contextKey) return { ok: false, error: "context key too long" };
      if (typeof v !== "string") return { ok: false, error: "context values must be strings" };
      if (v.length > LIMITS.contextValue) return { ok: false, error: "context value too long" };
      context[k] = v;
    }
  }

  let app: Record<string, string> | undefined;
  if (body.app !== undefined) {
    if (!isPlainObject(body.app)) return { ok: false, error: "app must be an object" };
    const appEntries = Object.entries(body.app);
    // The 8 KB body cap already bounds this, but bound it explicitly too — the
    // same reasoning as `context`, and it keeps stored objects a predictable shape.
    if (appEntries.length > LIMITS.appEntries) {
      return { ok: false, error: "too many app entries" };
    }
    app = Object.create(null) as Record<string, string>;
    for (const [k, v] of appEntries) {
      // Keys are bounded too — `context` capped its keys from the start and
      // `app` did not, which left a 4000-character key perfectly acceptable.
      if (k.length > LIMITS.appKey) return { ok: false, error: "app key too long" };
      if (typeof v !== "string") return { ok: false, error: "app values must be strings" };
      if (v.length > LIMITS.appValue) return { ok: false, error: "app value too long" };
      app[k] = v;
    }
  }

  const createdAt = trimmed(body.createdAt);
  if (createdAt && Number.isNaN(Date.parse(createdAt))) {
    return { ok: false, error: "malformed createdAt" };
  }

  return {
    ok: true,
    value: { id, kind: kind as SubmissionKind, message, email, context, app, createdAt },
  };
}

/** Lowercase hex of a SHA-256 digest. */
export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The object key.
 *
 *   submissions/{kind}/{YYYY}/{MM}/{DD}/{epochMillis}-{hash12}.json
 *
 * Unique AND meaningful, and every segment earns its place:
 *  - `kind` first, so the dashboard's prefix browser is one channel per click.
 *  - The date path comes from the SERVER clock, never the client's `createdAt` —
 *    a device with a skewed clock must not file itself under 2019.
 *  - `epochMillis` sorts lexicographically within a day.
 *  - `hash12` is the first 12 hex of SHA-256(submission id): it makes the key
 *    collision-proof within a millisecond, and makes a duplicate obvious — a
 *    retry whose 202 was lost in transit lands under a new millisecond but the
 *    SAME hash suffix, so two `…-a1b2c3d4e5f6.json` files are one submission,
 *    not two.
 */
export async function buildObjectKey(
  kind: SubmissionKind,
  id: string,
  receivedAt: Date,
): Promise<string> {
  const hash = (await sha256Hex(id)).slice(0, 12);
  const yyyy = String(receivedAt.getUTCFullYear());
  const mm = String(receivedAt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(receivedAt.getUTCDate()).padStart(2, "0");
  return `submissions/${kind}/${yyyy}/${mm}/${dd}/${receivedAt.getTime()}-${hash}.json`;
}

/**
 * Constant-time equality over two SHA-256 digests of the candidate and the
 * expected token. Hashing first means the comparison is over two fixed 32-byte
 * values, so neither the token's LENGTH nor its first differing byte is
 * observable in the response timing.
 */
export async function timingSafeEqualStrings(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(a)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(b)),
  ]);
  const va = new Uint8Array(da);
  const vb = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

/** Split the `SUBMIT_TOKENS` secret into accepted tokens. A LIST (not a single
 *  value) so the founder can rotate without a flag day: publish the new token,
 *  ship the app update, then drop the old one. */
export function parseTokens(secret: string | undefined): string[] {
  if (!secret) return [];
  return secret
    .split(/[,\s]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * Whether `presented` matches any configured token. FAILS CLOSED: no configured
 * tokens means nothing is accepted — the check never degrades to "allow all"
 * because the secret is missing. Every candidate is compared against every
 * token (no early return) so a match in slot 1 and a match in slot 3 take the
 * same time.
 */
export async function isAuthorized(
  presented: string | undefined,
  tokens: string[],
): Promise<boolean> {
  if (!presented || tokens.length === 0) return false;
  let matched = false;
  for (const token of tokens) {
    if (await timingSafeEqualStrings(presented, token)) matched = true;
  }
  return matched;
}

/** Pull the bearer token out of an `Authorization` header. */
export function bearerToken(header: string | null): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : undefined;
}
