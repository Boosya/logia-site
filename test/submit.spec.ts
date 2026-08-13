import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker, { type Env } from "../src/index";
import { MAX_BODY_BYTES } from "../src/submission";

/**
 * Handler tests. These run inside workerd against the REAL (local) R2
 * implementation bound by wrangler.jsonc, so "the object was written" is a
 * genuine assertion about `env.SUBMISSIONS`, not a mock's call log.
 */

const TOKEN = "test-token-primary";
const ROTATING_TOKEN = "test-token-rotating";
const IP = "203.0.113.9";

/** The REAL rate-limit binding from wrangler.jsonc is live in these tests, and
 *  it is keyed on the client IP's hash. Requests therefore come from a fresh
 *  synthetic IP by default, so one test's traffic can never exhaust another
 *  test's budget; tests that assert on the hash (or on the limiter itself) pin
 *  an IP explicitly. */
let ipCounter = 0;
function nextIP(): string {
  ipCounter += 1;
  return `198.51.100.${ipCounter % 254}:${ipCounter}`;
}

type TestEnv = Env & Record<string, unknown>;

function testEnv(overrides: Partial<TestEnv> = {}): Env {
  return { ...(env as unknown as TestEnv), ...overrides } as Env;
}

function submitRequest(
  body: unknown,
  init: {
    token?: string | null;
    method?: string;
    headers?: Record<string, string>;
    ip?: string;
  } = {},
): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "cf-connecting-ip": init.ip ?? nextIP(),
    ...init.headers,
  };
  const token = init.token === undefined ? TOKEN : init.token;
  if (token !== null) headers.authorization = `Bearer ${token}`;
  const method = init.method ?? "POST";
  return new Request("https://logia.page/api/submit", {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined
      : typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function send(request: Request, overrides: Partial<TestEnv> = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, testEnv(overrides), ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function storedKeys(): Promise<string[]> {
  const listing = await env.SUBMISSIONS.list({ prefix: "submissions/" });
  return listing.objects.map((o) => o.key).sort();
}

async function storedRecord(key: string): Promise<Record<string, unknown>> {
  const object = await env.SUBMISSIONS.get(key);
  expect(object, `no object at ${key}`).not.toBeNull();
  return JSON.parse(await object!.text());
}

const feedbackBody = {
  id: "11111111-2222-3333-4444-555555555555",
  kind: "feedback",
  message: "The Intermediate mode collapses a phrase it shouldn't.",
  app: { version: "0.3.0", build: "7", platform: "ios", locale: "en_GB" },
  createdAt: "2026-08-11T09:00:00.000Z",
};

beforeEach(async () => {
  // Each test starts from an empty bucket so "nothing was written" is provable.
  const listing = await env.SUBMISSIONS.list();
  await Promise.all(listing.objects.map((o) => env.SUBMISSIONS.delete(o.key)));
});

describe("POST /api/submit — the happy path", () => {
  it("stores the submission and answers 202", async () => {
    const response = await send(submitRequest(feedbackBody));
    expect(response.status).toBe(202);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.id).toBe(feedbackBody.id);
    expect(typeof body.receivedAt).toBe("string");

    const keys = await storedKeys();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(
      /^submissions\/feedback\/\d{4}\/\d{2}\/\d{2}\/\d+-[0-9a-f]{12}\.json$/,
    );
  });

  it("stores what the user typed, verbatim, plus a server envelope", async () => {
    await send(submitRequest(feedbackBody));
    const [key] = await storedKeys();
    const record = await storedRecord(key);

    expect(record.kind).toBe("feedback");
    expect(record.message).toBe(feedbackBody.message);
    expect(record.app).toEqual(feedbackBody.app);
    expect(record.createdAt).toBe(feedbackBody.createdAt);
    // Server-added envelope.
    expect(typeof record.receivedAt).toBe("string");
    expect(Number.isNaN(Date.parse(record.receivedAt as string))).toBe(false);
    expect("country" in record).toBe(true);
    expect(typeof record.ipHash).toBe("string");
  });

  it("NEVER stores the raw client IP — only a salted hash of it", async () => {
    await send(submitRequest(feedbackBody, { ip: IP }));
    const [key] = await storedKeys();
    const raw = await (await env.SUBMISSIONS.get(key))!.text();

    expect(raw).not.toContain(IP);
    expect(raw).not.toContain("cf-connecting-ip");
    const record = JSON.parse(raw);
    expect(record.ip).toBeUndefined();
    expect(record.ipHash).toMatch(/^[0-9a-f]{32}$/);
    // Salted: the same IP under a different salt must not produce the same hash,
    // otherwise the value would be a rainbow-table lookup away from the address.
    await env.SUBMISSIONS.delete(key);
    await send(submitRequest({ ...feedbackBody, id: "second-id" }, { ip: IP }), {
      IP_HASH_SALT: "a-completely-different-salt",
    });
    const [otherKey] = await storedKeys();
    const other = await storedRecord(otherKey);
    expect(other.ipHash).not.toBe(record.ipHash);
  });

  it("tags the object with greppable metadata", async () => {
    await send(submitRequest(feedbackBody));
    const [key] = await storedKeys();
    const object = await env.SUBMISSIONS.head(key);
    expect(object!.customMetadata).toEqual({
      submissionId: feedbackBody.id,
      kind: "feedback",
    });
    expect(object!.httpMetadata?.contentType).toContain("application/json");
  });

  it("files each kind under its own prefix", async () => {
    await send(submitRequest({ ...feedbackBody, id: "id-a", kind: "book_request" }));
    await send(
      submitRequest({ ...feedbackBody, id: "id-b", kind: "word_report", message: "wrong gloss" }),
    );
    await send(
      submitRequest({ id: "id-c", kind: "waitlist", email: "reader@example.com" }),
    );
    const keys = await storedKeys();
    expect(keys.some((k) => k.startsWith("submissions/book_request/"))).toBe(true);
    expect(keys.some((k) => k.startsWith("submissions/word_report/"))).toBe(true);
    expect(keys.some((k) => k.startsWith("submissions/waitlist/"))).toBe(true);
  });

  it("keeps the word/book context the reader was shown", async () => {
    await send(
      submitRequest({
        id: "word-1",
        kind: "word_report",
        message: "This is glossed as the participle, not the infinitive.",
        context: { book: "Merkur", word: "zucken", native: "en", target: "de" },
      }),
    );
    const [key] = await storedKeys();
    const record = await storedRecord(key);
    expect(record.context).toEqual({
      book: "Merkur",
      word: "zucken",
      native: "en",
      target: "de",
    });
  });

  it("makes a retry of the same submission recognisable by its hash suffix", async () => {
    await send(submitRequest(feedbackBody));
    await send(submitRequest(feedbackBody));
    const keys = await storedKeys();
    const suffix = (k: string) => k.split("-").pop();
    expect(keys).toHaveLength(2);
    expect(suffix(keys[0])).toBe(suffix(keys[1]));
  });
});

describe("POST /api/submit — authentication", () => {
  it("rejects a request with no token and stores nothing", async () => {
    const response = await send(submitRequest(feedbackBody, { token: null }));
    expect(response.status).toBe(401);
    expect(await storedKeys()).toEqual([]);
  });

  it("rejects a wrong token and stores nothing", async () => {
    const response = await send(submitRequest(feedbackBody, { token: "not-the-token" }));
    expect(response.status).toBe(401);
    expect(await storedKeys()).toEqual([]);
  });

  it("accepts either configured token, so the founder can rotate without a flag day", async () => {
    expect((await send(submitRequest(feedbackBody, { token: ROTATING_TOKEN }))).status).toBe(202);
  });

  it("FAILS CLOSED with no token configured: 503, and nothing is stored", async () => {
    const response = await send(submitRequest(feedbackBody), { SUBMIT_TOKENS: undefined });
    expect(response.status).toBe(503);
    expect(await storedKeys()).toEqual([]);
  });

  it("FAILS CLOSED with no IP salt configured, rather than storing an unsalted hash", async () => {
    const response = await send(submitRequest(feedbackBody), { IP_HASH_SALT: undefined });
    expect(response.status).toBe(503);
    expect(await storedKeys()).toEqual([]);
  });
});

describe("POST /api/submit — method, CORS and routing", () => {
  it("answers 405 to a GET and advertises POST", async () => {
    const response = await send(submitRequest(null, { method: "GET" }));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(await storedKeys()).toEqual([]);
  });

  it("does not open a CORS surface — no preflight is answered", async () => {
    const response = await send(
      submitRequest(null, {
        method: "OPTIONS",
        headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
      }),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("does not echo an Origin on a real submission either", async () => {
    const response = await send(
      submitRequest(feedbackBody, { headers: { origin: "https://evil.example" } }),
    );
    expect(response.status).toBe(202);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("answers 404 in JSON for an unknown /api path", async () => {
    const response = await send(
      new Request("https://logia.page/api/nope", { method: "POST" }),
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
  });
});

describe("POST /api/submit — the 8 KB cap, enforced twice", () => {
  it("rejects an over-declared Content-Length before reading the body", async () => {
    const response = await send(
      submitRequest(feedbackBody, {
        headers: { "content-length": String(MAX_BODY_BYTES + 1) },
      }),
    );
    expect(response.status).toBe(413);
    expect(await storedKeys()).toEqual([]);
  });

  it("rejects an over-sized body even when Content-Length under-declares it", async () => {
    // A body that is well over the cap. Whatever the transport says about its
    // length, the bytes actually read are measured and rejected.
    const huge = JSON.stringify({ ...feedbackBody, message: "x".repeat(MAX_BODY_BYTES * 2) });
    const response = await send(submitRequest(huge));
    expect(response.status).toBe(413);
    expect(await storedKeys()).toEqual([]);
  });

  it("measures BYTES, not characters, so multi-byte text can't slip past", async () => {
    // 3 bytes per character in UTF-8: ~2800 characters is under any character
    // limit but over the byte cap.
    const arabic = "ك".repeat(4200);
    const response = await send(submitRequest({ ...feedbackBody, message: arabic }));
    expect(response.status).toBe(413);
    expect(await storedKeys()).toEqual([]);
  });

  it("accepts a long-but-legal submission", async () => {
    const response = await send(submitRequest({ ...feedbackBody, message: "x".repeat(3000) }));
    expect(response.status).toBe(202);
  });
});

describe("POST /api/submit — validation", () => {
  it("rejects malformed JSON", async () => {
    const response = await send(submitRequest("{not json"));
    expect(response.status).toBe(400);
    expect(await storedKeys()).toEqual([]);
  });

  it("rejects an unknown kind, a missing id, and an empty submission", async () => {
    for (const body of [
      { ...feedbackBody, kind: "arbitrary" },
      { kind: "feedback", message: "x" },
      { id: "a", kind: "feedback" },
      { id: "a", kind: "waitlist" },
    ]) {
      const response = await send(submitRequest(body));
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(await storedKeys()).toEqual([]);
  });

  it("rejects a path-shaped id rather than letting it steer the key", async () => {
    const response = await send(submitRequest({ ...feedbackBody, id: "../../../secret" }));
    expect(response.status).toBe(400);
    expect(await storedKeys()).toEqual([]);
  });
});

describe("POST /api/submit — rate limiting", () => {
  it("answers 429 and stores nothing when the limiter says no", async () => {
    const response = await send(submitRequest(feedbackBody), {
      SUBMIT_RATE_LIMIT: { limit: async () => ({ success: false }) },
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(await storedKeys()).toEqual([]);
  });

  it("keys the limiter on the ipHash, never on the raw IP", async () => {
    const seen: string[] = [];
    await send(submitRequest(feedbackBody, { ip: IP }), {
      SUBMIT_RATE_LIMIT: {
        limit: async ({ key }: { key: string }) => {
          seen.push(key);
          return { success: true };
        },
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toContain(IP);
    expect(seen[0]).toMatch(/^[0-9a-f]{32}$/);
  });

  it("still accepts submissions when no limiter is bound", async () => {
    const response = await send(submitRequest(feedbackBody), { SUBMIT_RATE_LIMIT: undefined });
    expect(response.status).toBe(202);
    expect(await storedKeys()).toHaveLength(1);
  });

  it("FAILS OPEN when the limiter itself errors, rather than killing the endpoint", async () => {
    // The limiter is a secondary defence; the bearer check and the byte cap are
    // load-bearing. A limiter outage must not be indistinguishable from an
    // outage of the whole feature.
    const response = await send(submitRequest(feedbackBody), {
      SUBMIT_RATE_LIMIT: {
        limit: async () => {
          throw new Error("rate limiter unavailable");
        },
      },
    });
    expect(response.status).toBe(202);
    expect(await storedKeys()).toHaveLength(1);
  });

  it("throttles BEFORE reading or parsing the body", async () => {
    // A refused caller should cost us as little as possible: an over-sized,
    // malformed body must still be rejected as 429 (not 413/400), proving we
    // never read it.
    const response = await send(
      submitRequest("{ this is not json and it is enormous " + "x".repeat(MAX_BODY_BYTES * 2)),
      { SUBMIT_RATE_LIMIT: { limit: async () => ({ success: false }) } },
    );
    expect(response.status).toBe(429);
  });

  it("the REAL binding from wrangler.jsonc throttles a burst from one source", async () => {
    // Not a mock: this is the rate-limit binding the deploy config declares,
    // emulated by workerd. A burst well past the configured per-minute budget
    // from a single IP must start being refused — and refused requests must not
    // reach the bucket.
    // A FRESH source per run. The rate-limit namespace is real state with a
    // 10-per-60s budget, so a fixed IP makes two `npm test` runs inside the same
    // minute share one budget — the second run starts already throttled, sees
    // zero acceptances, and fails for a reason that has nothing to do with the
    // code under test.
    const burstIP = `192.0.2.${Math.floor(Math.random() * 200) + 20}`;
    const statuses: number[] = [];
    for (let i = 0; i < 15; i++) {
      const response = await send(submitRequest({ ...feedbackBody, id: `burst-${i}` }, { ip: burstIP }));
      statuses.push(response.status);
    }
    expect(statuses.filter((s) => s === 202).length).toBeGreaterThan(0);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
    expect(await storedKeys()).toHaveLength(statuses.filter((s) => s === 202).length);
  });
});

describe("POST /api/submit — the notifier seam", () => {
  it("with NO notifier configured, still answers 202 and still stores the object", async () => {
    const response = await send(submitRequest(feedbackBody), { NOTIFY_CHANNEL: undefined });
    expect(response.status).toBe(202);
    expect(await storedKeys()).toHaveLength(1);
  });

  it("with a notifier channel named but unimplemented, the submission is unaffected", async () => {
    const response = await send(submitRequest(feedbackBody), { NOTIFY_CHANNEL: "email" });
    expect(response.status).toBe(202);
    expect(await storedKeys()).toHaveLength(1);
  });
});

describe("POST /api/submit — storage failure", () => {
  it("does NOT claim success when the R2 put throws", async () => {
    const response = await send(submitRequest(feedbackBody), {
      SUBMISSIONS: {
        put: async () => {
          throw new Error("R2 is down");
        },
      } as unknown as R2Bucket,
    });
    // 5xx tells the app to keep the submission queued and retry — nothing is lost.
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("30");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.ok).toBeUndefined();
  });
});

describe("the static site still resolves", () => {
  // Every page and asset the live site actually has. This is the guard against
  // shipping a `public/` that is missing content: `assets.directory` publishes
  // exactly this tree, so a page absent here 404s in production. Needles are
  // <title> tags rather than body prose, so a copy edit doesn't break the test
  // while a MISSING PAGE still does.
  it("serves every page from ./public/ without running the Worker", async () => {
    for (const [path, title] of [
      ["/", "Logia — Learn a language by reading real books"],
      ["/about", "About — Logia"],
      ["/privacy", "Privacy Policy — Logia"],
      ["/support", "Support — Logia"],
      ["/team", "Team — Logia"],
      ["/terms", "Terms of Service — Logia"],
    ] as const) {
      const response = await SELF.fetch(`https://logia.page${path}`);
      expect(response.status, path).toBe(200);
      expect(await response.text(), path).toContain(`<title>${title}</title>`);
    }
  });

  it("serves the stylesheet and the image assets", async () => {
    const css = await SELF.fetch("https://logia.page/style.css");
    expect(css.status).toBe(200);
    expect(await css.text()).toContain("--bg");

    // The whole assets/ tree has to survive the move with its structure intact —
    // a flattened or half-copied tree breaks every image on the site.
    for (const asset of [
      "/assets/logia-icon.png",
      "/assets/founder.jpg",
      "/assets/shots/beginner.jpg",
      "/assets/team/ru.jpg",
      "/assets/team/principal-eng.jpg",
    ]) {
      const response = await SELF.fetch(`https://logia.page${asset}`);
      expect(response.status, asset).toBe(200);
    }
  });
});
