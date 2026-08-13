import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * Tests run inside workerd (the real Workers runtime) via
 * `@cloudflare/vitest-pool-workers`, driven by the SAME wrangler.jsonc the
 * deploy uses. That means the R2 binding under test is a real (local) R2
 * implementation, not a hand-written mock — so a test that stores an object and
 * reads it back is genuinely exercising `env.SUBMISSIONS.put`.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // The deployed Worker gets these from `wrangler secret put`. Tests
        // supply their own so the fail-closed path can be exercised by
        // OMITTING them per-test rather than by leaving the suite unconfigured.
        bindings: {
          SUBMIT_TOKENS: "test-token-primary, test-token-rotating",
          IP_HASH_SALT: "test-salt-value-not-a-real-secret",
        },
      },
    }),
  ],
});
