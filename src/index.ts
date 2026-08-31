import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { clientIp } from "./lib/client-ip";
import {
    generateId,
    generateOwnerToken,
} from "./lib/id";
import type { EntryStore } from "./lib/store";
import {
    claimKey,
    cloudflareKv,
} from "./lib/store";
import { verifyTurnstile } from "./lib/turnstile";
import type {
    Bindings,
    EntryKind,
    EntryRecord,
} from "./types";

const MIN_TTL = 60;
const MAX_TTL = 365 * 86400;
/**
 * 90 days, because the driving use case is an itinerary shared with travel
 * companions months before departure — a short TTL would expire the link before
 * the trip it describes. Abuse is bounded by the WAF rate-limit rule and the size
 * cap instead, not by making links die young.
 */
const DEFAULT_BLOB_TTL = 90 * 86400;
const DEFAULT_LINK_TTL = MAX_TTL;

const MAX_PAYLOAD_CHARS = 64_000;
const MAX_LINK_CHARS = 2_048;
const MAX_ID_CHARS = 64;

/** Handlers read storage off the context, so none of them names a Cloudflare type. */
type AppEnv = {
    Bindings: Bindings;
    Variables: { store: EntryStore; };
};

const entryKey = (id: string) => `entry:${id}`;

const app = new Hono<AppEnv>();

// The one line in the request path that knows which platform this is running on.
// Porting hop means swapping the adapter here; nothing downstream changes.
app.use("*", async (c, next) => {
    c.set("store", cloudflareKv(c.env.HOP_KV));
    await next();
});

app.use("*", async (c, next) => {
    const allowed = c.env.ALLOWED_ORIGINS.split(",").map(s => s.trim()).filter(Boolean);
    return cors({
        origin: origin => allowed.includes(origin) ? origin : null,
        // Content-Type is deliberately the only one a browser needs: uploads are
        // text/plain so they stay CORS-simple and skip the preflight round trip.
        allowHeaders: ["Content-Type", "CF-Turnstile-Token"],
        allowMethods: ["GET", "POST", "OPTIONS"],
        maxAge: 86400,
        // Hono infers the Input generic of a wildcard `use` handler as `any`, so the
        // context we hand back to cors()'s own middleware signature reads as unsafe.
        // The types are structurally fine; only Hono's own `any` makes it look otherwise.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    })(c, next);
});

app.get("/health", c =>
    c.json({
        status: "ok",
        service: "hop",
        time: new Date().toISOString(),
    }));

/**
 * Constant-time buffer comparison over standard WebCrypto only.
 *
 * workerd offers crypto.subtle.timingSafeEqual, but that is a Cloudflare extension
 * rather than part of the spec — it would vanish silently on Node or Deno, and the
 * breakage would surface at runtime on the admin auth path. The loop below never
 * exits early, so it leaks nothing beyond the length, and callers hash first so the
 * length is a constant 32 bytes anyway.
 */
function constantTimeEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
    const x = new Uint8Array(a);
    const y = new Uint8Array(b);
    if (x.length !== y.length) return false;
    let diff = 0;
    for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
    return diff === 0;
}

/**
 * Hash before comparing: the comparison needs equal-length inputs, and feeding it
 * the raw tokens would leak the secret's length through the length check.
 */
async function secretMatches(provided: string, expected: string): Promise<boolean> {
    if (!provided || !expected) return false;
    const encoder = new TextEncoder();
    const [a, b] = await Promise.all([
        crypto.subtle.digest("SHA-256", encoder.encode(provided)),
        crypto.subtle.digest("SHA-256", encoder.encode(expected)),
    ]);
    return constantTimeEqual(a, b);
}

const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
    const auth = c.req.header("Authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!await secretMatches(token, c.env.ADMIN_SECRET)) {
        return c.json({ error: "Unauthorized" }, 401);
    }
    await next();
};

/**
 * A corrupted or absent value both read as null. The two routes that read records
 * must not disagree here — one of them returning an unhandled 500 on bad JSON is
 * exactly the bug this shared helper exists to prevent.
 */
async function readRecord(store: EntryStore, id: string | undefined): Promise<EntryRecord | null> {
    if (!id || id.length > MAX_ID_CHARS) return null;
    const raw = await store.get(entryKey(id));
    if (!raw) return null;
    try {
        return JSON.parse(raw) as EntryRecord;
    } catch {
        return null;
    }
}

/** ownerToken is a bearer secret for updates — it must never leave through a read. */
function publicRecord(record: EntryRecord) {
    const { ownerToken: _ownerToken, ...rest } = record;
    return rest;
}

function clampTtl(raw: unknown, fallback: number): number {
    if (typeof raw !== "number" || Number.isNaN(raw)) return fallback;
    return Math.max(MIN_TTL, Math.min(MAX_TTL, Math.floor(raw)));
}

/**
 * Generate an id and claim it in one step, retrying on collision.
 *
 * Generating and writing are adjacent on purpose: an id that is checked for
 * freshness in one place and written in another leaves a wider window for two
 * writers to pick the same one, and losing that race silently overwrites somebody
 * else's entry. How narrow the window actually gets is up to the store — see
 * claimKey.
 */
async function putEntry(
    store: EntryStore,
    kind: EntryKind,
    payload: string,
    ttl: number,
    meta: Record<string, unknown>,
): Promise<EntryRecord> {
    for (let attempt = 0; attempt < 3; attempt++) {
        const now = Date.now();
        const record: EntryRecord = {
            id: generateId(),
            kind,
            payload,
            ownerToken: generateOwnerToken(),
            meta,
            createdAt: now,
            expiresAt: now + ttl * 1000,
        };
        if (await claimKey(store, entryKey(record.id), JSON.stringify(record), ttl)) {
            return record;
        }
    }
    throw new Error("Failed to generate a unique id");
}

// Anonymous ciphertext drop. The body is the payload itself as text/plain: JSON
// would trigger a preflight OPTIONS, costing a mobile round trip on the one request
// that sits between tapping "share" and seeing a link.
app.post("/api/v1/blobs", async c => {
    const ok = await verifyTurnstile(
        c.env.TURNSTILE_SECRET,
        c.req.header("CF-Turnstile-Token") ?? "",
        clientIp(c.req.raw.headers),
    );
    if (!ok) return c.json({ error: "Verification failed" }, 403);

    const payload = await c.req.text();
    if (!payload) return c.json({ error: "Empty payload" }, 400);
    if (payload.length > MAX_PAYLOAD_CHARS) {
        return c.json({ error: `Payload exceeds ${MAX_PAYLOAD_CHARS} characters` }, 413);
    }

    const ttl = clampTtl(Number(c.req.query("ttl")), DEFAULT_BLOB_TTL);
    const record = await putEntry(c.get("store"), "blob", payload, ttl, {});

    return c.json({
        id: record.id,
        editToken: record.ownerToken,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
        ttl,
    }, 201);
});

app.get("/api/v1/blobs/:id", async c => {
    const record = await readRecord(c.get("store"), c.req.param("id"));
    if (!record || record.kind !== "blob") {
        return c.json({ error: "Not found or expired" }, 404);
    }
    return c.json(publicRecord(record));
});

// Reserved so adding updatable links later does not change the API shape.
app.put("/api/v1/blobs/:id", c => c.json({ error: "Updating an entry is not implemented yet" }, 501));

app.post("/api/v1/links", requireAdmin, async c => {
    let body: { url?: unknown; ttl?: unknown; meta?: unknown; };
    try {
        body = await c.req.json();
    } catch {
        return c.json({ error: "Invalid JSON body" }, 400);
    }

    const url = body.url;
    if (typeof url !== "string" || !/^https?:\/\//.test(url)) {
        return c.json({ error: "Field 'url' must be an http(s) URL" }, 400);
    }
    if (url.length > MAX_LINK_CHARS) {
        return c.json({ error: `URL exceeds ${MAX_LINK_CHARS} characters` }, 400);
    }

    const ttl = clampTtl(body.ttl, DEFAULT_LINK_TTL);
    const meta = body.meta && typeof body.meta === "object" ? body.meta as Record<string, unknown> : {};
    const record = await putEntry(c.get("store"), "link", url, ttl, meta);

    return c.json({
        id: record.id,
        url: `${new URL(c.req.url).origin}/${record.id}`,
        target: url,
        expiresAt: record.expiresAt,
        ttl,
    }, 201);
});

app.delete("/api/v1/entries/:id", requireAdmin, async c => {
    const id = c.req.param("id");
    if (!id || id.length > MAX_ID_CHARS) return c.json({ error: "Invalid id" }, 400);
    await c.get("store").delete(entryKey(id));
    return c.body(null, 204);
});

// Short-code entry point. Redirecting is gated on the kind recorded at write time,
// so an anonymous blob whose plaintext happens to look like a URL can never turn
// this domain into an open redirect.
app.get("/:code", async c => {
    const record = await readRecord(c.get("store"), c.req.param("code"));
    if (!record) return c.json({ error: "Not found or expired" }, 404);

    if (record.kind === "link") return c.redirect(record.payload, 302);
    return c.json(publicRecord(record));
});

export default app;
