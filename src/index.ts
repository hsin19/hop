import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import {
    generateOwnerToken,
    generateUniqueId,
} from "./lib/id";
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

const app = new Hono<{ Bindings: Bindings; }>();

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
 * Hash before comparing: timingSafeEqual needs equal-length inputs, and feeding it
 * the raw tokens would leak the secret's length through the length check.
 */
async function secretMatches(provided: string, expected: string): Promise<boolean> {
    if (!provided || !expected) return false;
    const encoder = new TextEncoder();
    const [a, b] = await Promise.all([
        crypto.subtle.digest("SHA-256", encoder.encode(provided)),
        crypto.subtle.digest("SHA-256", encoder.encode(expected)),
    ]);
    return crypto.subtle.timingSafeEqual(a, b);
}

const requireAdmin: MiddlewareHandler<{ Bindings: Bindings; }> = async (c, next) => {
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
async function readRecord(kv: KVNamespace, id: string | undefined): Promise<EntryRecord | null> {
    if (!id || id.length > MAX_ID_CHARS) return null;
    const raw = await kv.get(`entry:${id}`);
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

async function putEntry(
    kv: KVNamespace,
    kind: EntryKind,
    payload: string,
    ttl: number,
    meta: Record<string, unknown>,
): Promise<EntryRecord> {
    const id = await generateUniqueId(kv);
    const now = Date.now();
    const record: EntryRecord = {
        id,
        kind,
        payload,
        ownerToken: generateOwnerToken(),
        meta,
        createdAt: now,
        expiresAt: now + ttl * 1000,
    };
    await kv.put(`entry:${id}`, JSON.stringify(record), { expirationTtl: ttl });
    return record;
}

// Anonymous ciphertext drop. The body is the payload itself as text/plain: JSON
// would trigger a preflight OPTIONS, costing a mobile round trip on the one request
// that sits between tapping "share" and seeing a link.
app.post("/api/v1/blobs", async c => {
    const ok = await verifyTurnstile(
        c.env.TURNSTILE_SECRET,
        c.req.header("CF-Turnstile-Token") ?? "",
        c.req.header("CF-Connecting-IP"),
    );
    if (!ok) return c.json({ error: "Verification failed" }, 403);

    const payload = await c.req.text();
    if (!payload) return c.json({ error: "Empty payload" }, 400);
    if (payload.length > MAX_PAYLOAD_CHARS) {
        return c.json({ error: `Payload exceeds ${MAX_PAYLOAD_CHARS} characters` }, 413);
    }

    const ttl = clampTtl(Number(c.req.query("ttl")), DEFAULT_BLOB_TTL);
    const record = await putEntry(c.env.HOP_KV, "blob", payload, ttl, {});

    return c.json({
        id: record.id,
        editToken: record.ownerToken,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
        ttl,
    }, 201);
});

app.get("/api/v1/blobs/:id", async c => {
    const record = await readRecord(c.env.HOP_KV, c.req.param("id"));
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
    const record = await putEntry(c.env.HOP_KV, "link", url, ttl, meta);

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
    await c.env.HOP_KV.delete(`entry:${id}`);
    return c.body(null, 204);
});

// Short-code entry point. Redirecting is gated on the kind recorded at write time,
// so an anonymous blob whose plaintext happens to look like a URL can never turn
// this domain into an open redirect.
app.get("/:code", async c => {
    const record = await readRecord(c.env.HOP_KV, c.req.param("code"));
    if (!record) return c.json({ error: "Not found or expired" }, 404);

    if (record.kind === "link") return c.redirect(record.payload, 302);
    return c.json(publicRecord(record));
});

export default app;
