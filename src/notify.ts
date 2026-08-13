/**
 * Notification seam — the "tell someone a submission arrived" hook.
 *
 * DELIBERATELY UNIMPLEMENTED (founder decision, 2026-08-11). The durable R2
 * write IS the feature: a submission that lands in the private bucket is not
 * lost, and the founder reads the bucket. Wiring a third-party mail API
 * (Resend / Cloudflare Email Service / MailChannels) would add an API key to
 * rotate, a vendor to trust with user-typed text and email addresses, and a
 * second failure mode — for something that only saves opening a dashboard.
 *
 * So this ships as a real seam with exactly one branch: no notifier configured
 * → `{ skipped: true }`. `index.ts` calls it through `ctx.waitUntil`, so even
 * once a real branch exists it can never fail the request or delay the 202.
 *
 * TO IMPLEMENT LATER, an implementer would:
 *   1. add a secret (e.g. `RESEND_API_KEY`) and set `NOTIFY_CHANNEL="email"`,
 *   2. add a branch below that POSTs a short digest — kind, receivedAt, the
 *      object key, and whether the user left an email — to the provider,
 *   3. keep the BODY out of the notification (the bucket is the record of
 *      truth; a mail relay is one more copy of user text to secure),
 *   4. keep every failure inside this function: it must never throw into the
 *      request path, and it must never be awaited by the handler.
 *
 * Note for whoever picks this up: the repo's own docs used to describe the app
 * as having "no backend, no data collected by us" (spec.md, the Google Forms
 * era). That is no longer true as of this feature — it is a Worker + a private
 * bucket — and the privacy policy has to say so BEFORE any mail relay is added
 * on top.
 */

export interface NotifyEnv {
  /** Selects a notifier. Unset (the shipped state) → the no-op branch. */
  NOTIFY_CHANNEL?: string;
}

/** What the notifier is told about a stored submission. Metadata only — the
 *  user's text stays in the bucket. */
export interface NotifyRecord {
  kind: string;
  key: string;
  receivedAt: string;
  hasEmail: boolean;
}

export type NotifyResult =
  | { skipped: true; reason: string }
  | { skipped: false; channel: string };

/**
 * Best-effort notification. Never throws: the caller passes this to
 * `ctx.waitUntil`, and a notifier problem must never turn a stored submission
 * into a failed request.
 */
export async function notify(env: NotifyEnv, record: NotifyRecord): Promise<NotifyResult> {
  const channel = env.NOTIFY_CHANNEL?.trim();
  if (!channel) {
    return { skipped: true, reason: "no NOTIFY_CHANNEL configured" };
  }
  // A channel name is configured but this build has no implementation for it.
  // Log and move on — the submission is already durable in R2.
  console.log(
    `[notify] channel "${channel}" configured but not implemented; ` +
      `submission ${record.kind} stored at ${record.key}`,
  );
  return { skipped: true, reason: `channel "${channel}" not implemented` };
}
