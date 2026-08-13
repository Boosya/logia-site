/**
 * logia.page Worker.
 *
 * Two jobs, in this order:
 *  1. `POST /api/submit` — the in-app submission channel. The iOS app posts the
 *     four things a user can send us (feedback, a book/language request, a
 *     wrong-gloss word report, an e-ink waitlist signup) and this Worker writes
 *     each one, verbatim plus a server envelope, into a PRIVATE R2 bucket.
 *  2. Everything else — the static site (`/`, `/privacy`, `/support`, the
 *     stylesheet), served straight off Cloudflare's asset host from `./public/`.
 *     `assets.run_worker_first: ["/api/*"]` in wrangler.jsonc means only the API
 *     prefix ever reaches this code; a request for `/privacy` never pays for it.
 *
 * WHY R2 AND NOT A FORM SERVICE: the app already downloads its books from R2.
 * Uploading a submission is the same trust boundary in reverse — no third party
 * sees what a user typed, no vendor account to keep alive, and the founder owns
 * the data. No R2 credential is in the app: the app holds only a shared token
 * for THIS endpoint, and only this Worker can write to the bucket.
 *
 * DESIGN INVARIANTS
 *  - The R2 `put` is AWAITED and is the only thing that can fail the request.
 *    If we return 202, the object is durable. Everything optional (the notifier)
 *    goes through `ctx.waitUntil` so it can neither delay nor fail the response.
 *  - No CORS headers, ever. This endpoint is for the app, not for a browser on
 *    any origin; there is no site form that posts to it.
 *  - The client IP is never stored — only a salted hash of it (`ipHash`), which
 *    is also the rate-limit key.
 */

import { notify } from "./notify";
import {
  bearerToken,
  buildObjectKey,
  isAuthorized,
  MAX_BODY_BYTES,
  parseTokens,
  sha256Hex,
  StoredSubmission,
  validateSubmission,
} from "./submission";

/** Cloudflare's rate-limit binding. Optional in the type because the Worker must
 *  still serve correctly before the founder creates the namespace. */
interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  /** PRIVATE bucket, separate from the public books bucket. Never make it public. */
  SUBMISSIONS: R2Bucket;
  /** Accepted app tokens, comma/whitespace separated. Secret. Missing → 503. */
  SUBMIT_TOKENS?: string;
  /** Salt for `ipHash`. Secret. Missing → 503 (an unsalted IPv4 hash is reversible). */
  IP_HASH_SALT?: string;
  /** Optional; absent until the founder creates the rate-limit namespace. */
  SUBMIT_RATE_LIMIT?: RateLimiter;
  /** Selects a notifier; unset in the shipped config. See notify.ts. */
  NOTIFY_CHANNEL?: string;
  /** Static-asset binding (declared so the type is complete; routing is handled
   *  by `run_worker_first`, so we never have to call it). */
  ASSETS?: Fetcher;
}

const SUBMIT_PATH = "/api/submit";

/** JSON response helper. `no-store` because none of these are cacheable and a
 *  cached 202 would be actively wrong. */
function json(body: unknown, status: number, extraHeaders: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === SUBMIT_PATH) {
      return handleSubmit(request, env, ctx);
    }

    // Any other /api/* path: this is an app-facing API surface, not a site
    // route, so answer in JSON rather than falling through to the 404 page.
    if (url.pathname.startsWith("/api/")) {
      return json({ error: "not found" }, 404);
    }

    // Unreachable in production (`run_worker_first` only sends us /api/*), but
    // a correct fallback for a direct invocation or a config change.
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

/**
 * Read the request body as UTF-8 text, giving up as soon as more than
 * `maxBytes` have arrived. Returns `null` when the cap is exceeded.
 *
 * Deliberately NOT `request.text()`: that buffers whatever the client sends
 * before anyone can measure it, so a large body would be paid for in full just
 * to be rejected. Here the reader is cancelled mid-stream instead.
 */
async function readCappedText(request: Request, maxBytes: number): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/**
 * Ask the rate limiter whether this key may proceed. FAILS OPEN.
 *
 * The limiter is a SECONDARY defence — the bearer-token check and the 8 KB cap
 * are the load-bearing ones. If the binding is absent (the founder hasn't
 * created the namespace yet) or its `limit()` rejects (a platform blip), the
 * right answer is to accept the submission, not to take the endpoint 100% down
 * and start bouncing every user's feedback. A limiter outage must never be
 * indistinguishable from an outage of the feature.
 */
async function withinRateLimit(env: Env, key: string): Promise<boolean> {
  if (!env.SUBMIT_RATE_LIMIT) return true;
  try {
    const { success } = await env.SUBMIT_RATE_LIMIT.limit({ key });
    return success;
  } catch (err) {
    console.error("[submit] rate limiter failed; failing open", err);
    return true;
  }
}

async function handleSubmit(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // POST only. No OPTIONS handler on purpose: there is no browser client, so
  // there is no preflight to answer and no CORS surface to get wrong.
  if (request.method !== "POST") {
    return json({ error: "method not allowed" }, 405, { allow: "POST" });
  }

  // FAIL CLOSED. Without the token list there is nothing to authenticate
  // against; without the salt we cannot hash an IP safely. In neither case may
  // we accept the request. 503, not 401 — the client is fine, the server isn't.
  const tokens = parseTokens(env.SUBMIT_TOKENS);
  if (tokens.length === 0 || !env.IP_HASH_SALT) {
    return json({ error: "submission channel unconfigured" }, 503);
  }

  if (!(await isAuthorized(bearerToken(request.headers.get("authorization")), tokens))) {
    return json({ error: "unauthorized" }, 401);
  }

  // The IP is hashed once and used for two things — the rate-limit key and the
  // stored `ipHash` — so the raw address exists only as a local for the length
  // of this function and is never written anywhere.
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const ipHash = (await sha256Hex(`${env.IP_HASH_SALT}:${ip}`)).slice(0, 32);

  // Rate limit as early as possible — straight after auth, BEFORE we read,
  // parse or validate a body. Throttling is only worth having if it costs the
  // abusive caller more than it costs us, and the key needs nothing but the IP.
  if (!(await withinRateLimit(env, ipHash))) {
    return json({ error: "too many requests" }, 429, { "retry-after": "60" });
  }

  // CAP #1 — the DECLARED size, checked before a single byte is read.
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return json({ error: "payload too large" }, 413);
  }

  // CAP #2 — the ACTUAL size. `Content-Length` is client-supplied and can be
  // absent (chunked) or a lie, so the real bytes are counted too — as they
  // arrive, aborting the stream the moment the budget is blown, so an oversized
  // body is never fully buffered. Counted in BYTES, not characters: a message of
  // emoji or Arabic is several bytes per character and must not slip past a
  // check done in UTF-16 units.
  const raw = await readCappedText(request, MAX_BODY_BYTES);
  if (raw === null) {
    return json({ error: "payload too large" }, 413);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return json({ error: "malformed JSON" }, 400);
  }

  const validation = validateSubmission(parsed);
  if (!validation.ok) {
    return json({ error: validation.error }, 400);
  }
  const submission = validation.value;

  const receivedAt = new Date();
  const record: StoredSubmission = {
    ...submission,
    receivedAt: receivedAt.toISOString(),
    // ONLY `cf.country`. `cf-ipcountry` is a request HEADER, so a client can
    // set it to anything it likes — storing it would mean recording a value the
    // sender chose while presenting it as an observation we made. Absent (local
    // dev, or a request that never crossed the edge) is honest; a forged country
    // is not.
    country: (request as { cf?: { country?: string } }).cf?.country ?? null,
    ipHash,
  };
  const key = await buildObjectKey(submission.kind, submission.id, receivedAt);

  // THE ONLY AWAITED FAILURE POINT. If this throws we return 5xx and the app
  // keeps the submission in its on-disk queue and retries — nothing is lost.
  try {
    await env.SUBMISSIONS.put(key, JSON.stringify(record, null, 2), {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
      // Greppable without downloading objects: `submissionId` identifies a
      // duplicate retry, `kind` supports a dashboard filter.
      customMetadata: { submissionId: submission.id, kind: submission.kind },
    });
  } catch (err) {
    console.error("[submit] R2 put failed", key, err);
    return json({ error: "storage unavailable" }, 503, { "retry-after": "30" });
  }

  // Fire-and-forget, AFTER the object is durable. Currently a no-op branch.
  ctx.waitUntil(
    notify(env, {
      kind: submission.kind,
      key,
      receivedAt: record.receivedAt,
      hasEmail: Boolean(submission.email),
    }).catch((err) => console.error("[submit] notify failed", err)),
  );

  // 202, not 201: the submission is stored, but "we have it" is the whole
  // promise — there is no resource for the client to go and read.
  return json({ ok: true, id: submission.id, receivedAt: record.receivedAt }, 202);
}
