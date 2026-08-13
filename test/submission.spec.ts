import { describe, expect, it } from "vitest";
import {
  bearerToken,
  buildObjectKey,
  isAuthorized,
  LIMITS,
  MAX_BODY_BYTES,
  parseTokens,
  SUBMISSION_KINDS,
  timingSafeEqualStrings,
  validateSubmission,
} from "../src/submission";

/** Pure-logic tests: the rules that decide whether a submission is accepted and
 *  where it lands, with no Worker, no bindings, and no network. */

describe("validateSubmission", () => {
  const feedback = { id: "abc-123", kind: "feedback", message: "the gloss is wrong" };

  it("accepts a well-formed submission of every kind", () => {
    for (const kind of SUBMISSION_KINDS) {
      const body =
        kind === "waitlist"
          ? { id: "abc-123", kind, email: "reader@example.com" }
          : { id: "abc-123", kind, message: "hello" };
      const result = validateSubmission(body);
      expect(result.ok, `${kind} should validate`).toBe(true);
    }
  });

  it("rejects an unknown kind so it can never create a stray key prefix", () => {
    const result = validateSubmission({ ...feedback, kind: "spam" });
    expect(result).toEqual({ ok: false, error: "unknown kind" });
  });

  it("rejects a missing or non-object body", () => {
    expect(validateSubmission(null).ok).toBe(false);
    expect(validateSubmission("hello").ok).toBe(false);
    expect(validateSubmission([1, 2]).ok).toBe(false);
  });

  it("requires an id and rejects one that could escape the key prefix", () => {
    expect(validateSubmission({ kind: "feedback", message: "x" })).toEqual({
      ok: false,
      error: "missing id",
    });
    // A path-shaped id must never reach the key builder.
    expect(validateSubmission({ ...feedback, id: "../../etc/passwd" })).toEqual({
      ok: false,
      error: "malformed id",
    });
    expect(validateSubmission({ ...feedback, id: "a/b" }).ok).toBe(false);
    expect(validateSubmission({ ...feedback, id: "x".repeat(LIMITS.id + 1) })).toEqual({
      ok: false,
      error: "id too long",
    });
  });

  it("requires something actionable: a message, or an email for the waitlist", () => {
    expect(validateSubmission({ id: "a", kind: "feedback" })).toEqual({
      ok: false,
      error: "message is required",
    });
    // Whitespace is not a message.
    expect(validateSubmission({ id: "a", kind: "feedback", message: "   " }).ok).toBe(false);
    expect(validateSubmission({ id: "a", kind: "waitlist" })).toEqual({
      ok: false,
      error: "waitlist needs an email",
    });
    // The waitlist's note is optional — an email alone is a complete signup.
    expect(validateSubmission({ id: "a", kind: "waitlist", email: "r@e.com" }).ok).toBe(true);
  });

  it("rejects an over-long message rather than silently truncating it", () => {
    const result = validateSubmission({ ...feedback, message: "x".repeat(LIMITS.message + 1) });
    expect(result).toEqual({ ok: false, error: "message too long" });
  });

  it("rejects a malformed email but accepts ordinary ones", () => {
    expect(validateSubmission({ ...feedback, email: "not-an-email" }).ok).toBe(false);
    expect(validateSubmission({ ...feedback, email: "a@b" }).ok).toBe(false);
    expect(validateSubmission({ ...feedback, email: "reader+tag@example.co.uk" }).ok).toBe(true);
  });

  it("carries word-report context through, and bounds it", () => {
    const result = validateSubmission({
      ...feedback,
      kind: "word_report",
      context: { book: "GreyLine", word: "الكتاب", lemma: "كتاب", native: "ru", target: "ar" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.context).toEqual({
        book: "GreyLine",
        word: "الكتاب",
        lemma: "كتاب",
        native: "ru",
        target: "ar",
      });
    }
    expect(validateSubmission({ ...feedback, context: "nope" }).ok).toBe(false);
    expect(validateSubmission({ ...feedback, context: { a: 1 } }).ok).toBe(false);
    expect(
      validateSubmission({ ...feedback, context: { a: "x".repeat(LIMITS.contextValue + 1) } }).ok,
    ).toBe(false);
    const tooMany = Object.fromEntries(
      Array.from({ length: LIMITS.contextEntries + 1 }, (_, i) => [`k${i}`, "v"]),
    );
    expect(validateSubmission({ ...feedback, context: tooMany }).ok).toBe(false);
  });

  it("bounds the app metadata block", () => {
    expect(
      validateSubmission({ ...feedback, app: { platform: "ios", version: "0.3.0" } }).ok,
    ).toBe(true);
    expect(validateSubmission({ ...feedback, app: { platform: 7 } }).ok).toBe(false);
    expect(
      validateSubmission({ ...feedback, app: { v: "x".repeat(LIMITS.appValue + 1) } }).ok,
    ).toBe(false);
    const tooMany = Object.fromEntries(
      Array.from({ length: LIMITS.appEntries + 1 }, (_, i) => [`k${i}`, "v"]),
    );
    expect(validateSubmission({ ...feedback, app: tooMany })).toEqual({
      ok: false,
      error: "too many app entries",
    });
    // Keys were unbounded here while `context` capped its own — a 4000-character
    // app key used to be perfectly acceptable.
    expect(
      validateSubmission({ ...feedback, app: { ["k".repeat(LIMITS.appKey + 1)]: "v" } }),
    ).toEqual({ ok: false, error: "app key too long" });
  });

  it("accepts the app block the iOS client actually sends", () => {
    // Mirrors `Submission.appMetadata()` after locale normalisation. The long
    // form ("ru_RU@calendar=gregorian;currency=rub;numbers=latn", 50 chars) is
    // exactly what used to 400 every Russian and Arabic user's submission.
    expect(
      validateSubmission({
        ...feedback,
        app: { platform: "ios", version: "0.3.0", build: "7", locale: "ru_RU" },
      }).ok,
    ).toBe(true);
    expect(
      validateSubmission({
        ...feedback,
        app: { locale: "ru_RU@calendar=gregorian;currency=rub;numbers=latn" },
      }),
    ).toEqual({ ok: false, error: "app value too long" });
  });

  it("accepts input exactly AT each boundary, not just under it", () => {
    // An off-by-one that rejects legal input would be invisible without this.
    expect(validateSubmission({ ...feedback, message: "x".repeat(LIMITS.message) }).ok).toBe(true);
    expect(validateSubmission({ ...feedback, id: "a".repeat(LIMITS.id) }).ok).toBe(true);
    expect(
      validateSubmission({ ...feedback, context: { ["k".repeat(LIMITS.contextKey)]: "v" } }).ok,
    ).toBe(true);
    expect(
      validateSubmission({ ...feedback, context: { k: "v".repeat(LIMITS.contextValue) } }).ok,
    ).toBe(true);
    const exactlyEnough = Object.fromEntries(
      Array.from({ length: LIMITS.contextEntries }, (_, i) => [`k${i}`, "v"]),
    );
    expect(validateSubmission({ ...feedback, context: exactlyEnough }).ok).toBe(true);
    // An email at exactly the cap (local part padded to hit 254 characters).
    const atCap = "a".repeat(LIMITS.email - "@example.com".length) + "@example.com";
    expect(atCap.length).toBe(LIMITS.email);
    expect(validateSubmission({ ...feedback, email: atCap }).ok).toBe(true);
  });

  it("caps the email length", () => {
    const overCap = "a".repeat(LIMITS.email - "@example.com".length + 1) + "@example.com";
    expect(overCap.length).toBe(LIMITS.email + 1);
    expect(validateSubmission({ ...feedback, email: overCap })).toEqual({
      ok: false,
      error: "email too long",
    });
  });

  it("caps context KEYS, not just values", () => {
    expect(
      validateSubmission({ ...feedback, context: { ["k".repeat(LIMITS.contextKey + 1)]: "v" } }),
    ).toEqual({ ok: false, error: "context key too long" });
  });

  it("counts the message in UTF-16 units, the same unit the app counts", () => {
    // A DECOMPOSED "e" + U+0301 is ONE grapheme cluster but TWO UTF-16 units.
    // Swift's `String.count` counts grapheme clusters, so an app that counted
    // that way would let a 2001-character message past the client and straight
    // into a 400 here — a rejection the user cannot act on. Both sides count
    // `.length` / `.utf16.count`.
    const decomposed = "e\u0301".repeat(LIMITS.message / 2 + 1);
    const graphemes = [
      ...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(decomposed),
    ].length;
    expect(graphemes).toBeLessThanOrEqual(LIMITS.message);
    expect(decomposed.length).toBeGreaterThan(LIMITS.message);
    expect(validateSubmission({ ...feedback, message: decomposed })).toEqual({
      ok: false,
      error: "message too long",
    });
  });

  it("reports a wrong TYPE as a type error, not as a missing field", () => {
    expect(validateSubmission({ ...feedback, message: 42 })).toEqual({
      ok: false,
      error: "message must be a string",
    });
  });

  it("gives context and app null-prototype objects", () => {
    const result = validateSubmission({
      ...feedback,
      context: { a: "1" },
      app: { platform: "ios" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.getPrototypeOf(result.value.context!)).toBeNull();
      expect(Object.getPrototypeOf(result.value.app!)).toBeNull();
    }
  });

  it("rejects a createdAt that isn't a date", () => {
    expect(validateSubmission({ ...feedback, createdAt: "yesterday" }).ok).toBe(false);
    expect(validateSubmission({ ...feedback, createdAt: "2026-08-11T09:00:00Z" }).ok).toBe(true);
  });

  it("trims and treats empty strings as absent", () => {
    const result = validateSubmission({ ...feedback, message: "  hi  ", email: "  " });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.message).toBe("hi");
      expect(result.value.email).toBeUndefined();
    }
  });
});

describe("buildObjectKey", () => {
  const at = new Date("2026-08-11T09:07:05.123Z");

  it("uses the kind/date/millis/hash scheme, with UTC date parts from the SERVER clock", async () => {
    const key = await buildObjectKey("word_report", "abc-123", at);
    expect(key).toMatch(
      /^submissions\/word_report\/2026\/08\/11\/\d+-[0-9a-f]{12}\.json$/,
    );
    expect(key).toContain(`/${at.getTime()}-`);
  });

  it("zero-pads month and day so keys sort lexicographically", async () => {
    const key = await buildObjectKey("feedback", "x", new Date("2026-01-02T00:00:00Z"));
    expect(key.startsWith("submissions/feedback/2026/01/02/")).toBe(true);
  });

  it("gives the same hash suffix to a retry of the same submission id", async () => {
    const first = await buildObjectKey("feedback", "same-id", new Date(1000));
    const second = await buildObjectKey("feedback", "same-id", new Date(9000));
    const suffix = (k: string) => k.split("-").pop();
    expect(suffix(first)).toBe(suffix(second));
    expect(first).not.toBe(second);
  });

  it("gives different hash suffixes to different submissions", async () => {
    const a = await buildObjectKey("feedback", "id-a", at);
    const b = await buildObjectKey("feedback", "id-b", at);
    expect(a.split("-").pop()).not.toBe(b.split("-").pop());
  });
});

describe("token check", () => {
  it("splits a multi-token secret on commas and whitespace", () => {
    expect(parseTokens("a, b\nc  d")).toEqual(["a", "b", "c", "d"]);
    expect(parseTokens("")).toEqual([]);
    expect(parseTokens(undefined)).toEqual([]);
  });

  it("FAILS CLOSED when no token is configured", async () => {
    expect(await isAuthorized("anything", [])).toBe(false);
    expect(await isAuthorized(undefined, ["real"])).toBe(false);
  });

  it("accepts any configured token (so a rotation has an overlap window)", async () => {
    const tokens = parseTokens("old-token, new-token");
    expect(await isAuthorized("old-token", tokens)).toBe(true);
    expect(await isAuthorized("new-token", tokens)).toBe(true);
    expect(await isAuthorized("other-token", tokens)).toBe(false);
  });

  it("compares in constant time over digests, so length is not observable", async () => {
    expect(await timingSafeEqualStrings("abc", "abc")).toBe(true);
    expect(await timingSafeEqualStrings("abc", "abd")).toBe(false);
    expect(await timingSafeEqualStrings("abc", "abcdefghijklmnop")).toBe(false);
    expect(await timingSafeEqualStrings("", "")).toBe(true);
  });
});

describe("bearerToken", () => {
  it("extracts the token and tolerates casing and padding", () => {
    expect(bearerToken("Bearer abc123")).toBe("abc123");
    expect(bearerToken("bearer   abc123  ")).toBe("abc123");
    expect(bearerToken(null)).toBeUndefined();
    expect(bearerToken("Basic abc123")).toBeUndefined();
    expect(bearerToken("Bearer")).toBeUndefined();
  });
});

describe("limits", () => {
  // ⚠️ LITERAL expectations on purpose. Every other test in this file references
  // `LIMITS.*` symbolically, so changing `LIMITS.email` to 200 would keep all of
  // them green — and the Swift mirror test only pins the Swift side. The two
  // halves of the mirror would drift apart in silence and the app would start
  // sending 254-character addresses into a 400 the user cannot act on.
  // These literals are the OTHER half of
  // `LogiaTests/SubmissionTests.testClientLimitsMatchTheWorkerLimits`.
  it("pins every limit the iOS client mirrors", () => {
    expect(MAX_BODY_BYTES).toBe(8 * 1024);
    expect(LIMITS.message).toBe(4000);
    expect(LIMITS.email).toBe(254);
    expect(LIMITS.id).toBe(64);
    expect(LIMITS.contextEntries).toBe(12);
    expect(LIMITS.contextKey).toBe(40);
    expect(LIMITS.contextValue).toBe(300);
    expect(LIMITS.appEntries).toBe(8);
    expect(LIMITS.appKey).toBe(40);
    expect(LIMITS.appValue).toBe(40);
  });
});
