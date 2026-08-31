import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
    plugins: [
        cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            // Deterministic secrets so tests assert real auth behaviour instead of
            // the tautology where an absent ADMIN_SECRET makes every token match.
            // TURNSTILE_SECRET stays unset: that is the shipped default, and the
            // one test that needs it enabled overrides it per-request.
            miniflare: {
                bindings: {
                    ADMIN_SECRET: "test-admin-secret",
                },
            },
        }),
    ],
    test: {
        include: ["test/**/*.spec.ts"],
        coverage: {
            // workerd lacks the node inspector Session API that v8 coverage needs.
            provider: "istanbul",
            reporter: ["text", "text-summary", "html", "lcov"],
            include: ["src/**/*.ts"],
        },
    },
});
