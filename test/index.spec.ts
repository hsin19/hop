import { env } from "cloudflare:workers";
import {
    describe,
    expect,
    it,
} from "vitest";
import app from "../src/index";

const ADMIN = "Bearer test-admin-secret";

function postBlob(payload: string, init: RequestInit = {}) {
    return app.request("/api/v1/blobs", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: payload,
        ...init,
    }, env);
}

function postLink(body: unknown, auth: string | null = ADMIN) {
    return app.request("/api/v1/links", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            ...(auth ? { Authorization: auth } : {}),
        },
        body: JSON.stringify(body),
    }, env);
}

describe("health", () => {
    it("reports the service name so the deploy smoke check can assert on it", async () => {
        const res = await app.request("/health", {}, env);
        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toMatchObject({ status: "ok", service: "hop" });
    });
});

describe("POST /api/v1/blobs", () => {
    it("stores a payload and returns an 8-char id with an edit token", async () => {
        const res = await postBlob("ciphertext-abc");
        expect(res.status).toBe(201);

        const body = await res.json<{ id: string; editToken: string; ttl: number; }>();
        expect(body.id).toMatch(/^[A-Za-z0-9]{8}$/);
        expect(body.editToken).toMatch(/^[A-Za-z0-9]{32}$/);
        expect(body.ttl).toBe(90 * 86400);
    });

    it("round-trips the payload through GET", async () => {
        const { id } = await (await postBlob("ciphertext-round-trip")).json<{ id: string; }>();

        const res = await app.request(`/api/v1/blobs/${id}`, {}, env);
        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toMatchObject({ payload: "ciphertext-round-trip", kind: "blob" });
    });

    it("never leaks ownerToken through a read — it is the bearer secret for updates", async () => {
        const { id } = await (await postBlob("secret-bearing")).json<{ id: string; }>();

        const viaApi = await (await app.request(`/api/v1/blobs/${id}`, {}, env)).json<Record<string, unknown>>();
        const viaCode = await (await app.request(`/${id}`, {}, env)).json<Record<string, unknown>>();

        expect(viaApi).not.toHaveProperty("ownerToken");
        expect(viaCode).not.toHaveProperty("ownerToken");
    });

    it("keeps createdAt and expiresAt in the same unit", async () => {
        const { id } = await (await postBlob("unit-check")).json<{ id: string; }>();
        const record = await (await app.request(`/api/v1/blobs/${id}`, {}, env))
            .json<{ createdAt: number; expiresAt: number; }>();

        // Both are epoch milliseconds, so the gap is the TTL in ms. A seconds/ms mix
        // would put expiresAt in 1970 and this difference wildly off.
        expect(record.expiresAt - record.createdAt).toBe(90 * 86400 * 1000);
    });

    it("rejects an empty payload", async () => {
        expect((await postBlob("")).status).toBe(400);
    });

    it("rejects a payload over the size cap", async () => {
        expect((await postBlob("x".repeat(64_001))).status).toBe(413);
    });

    it("clamps a caller-supplied ttl into the allowed range", async () => {
        const res = await app.request("/api/v1/blobs?ttl=1", {
            method: "POST",
            headers: { "Content-Type": "text/plain" },
            body: "short-ttl",
        }, env);

        await expect(res.json()).resolves.toMatchObject({ ttl: 60 });
    });
});

describe("open redirect", () => {
    // The reason the blob/link split exists. Anyone may write a blob, so if a blob
    // whose plaintext looks like a URL could redirect, hop would be a free phishing
    // hop on hsin19.com and could get the whole domain flagged.
    it("does NOT redirect for a blob whose payload is a URL", async () => {
        const { id } = await (await postBlob("https://phishing.example/login")).json<{ id: string; }>();

        const res = await app.request(`/${id}`, {}, env);
        expect(res.status).toBe(200);
        expect(res.headers.get("location")).toBeNull();
        await expect(res.json()).resolves.toMatchObject({ kind: "blob" });
    });
});

describe("POST /api/v1/links", () => {
    it("rejects an unauthenticated caller", async () => {
        expect((await postLink({ url: "https://example.com" }, null)).status).toBe(401);
    });

    it("rejects a wrong bearer token", async () => {
        expect((await postLink({ url: "https://example.com" }, "Bearer nope")).status).toBe(401);
    });

    it("rejects a payload that is not an http(s) URL", async () => {
        expect((await postLink({ url: "javascript:alert(1)" })).status).toBe(400);
        expect((await postLink({ url: "not a url" })).status).toBe(400);
        expect((await postLink({})).status).toBe(400);
    });

    it("redirects for a link created through the admin endpoint", async () => {
        const { id } = await (await postLink({ url: "https://example.com/target" })).json<{ id: string; }>();

        const res = await app.request(`/${id}`, {}, env);
        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toBe("https://example.com/target");
    });
});

describe("DELETE /api/v1/entries/:id", () => {
    it("requires admin auth", async () => {
        const { id } = await (await postBlob("delete-me")).json<{ id: string; }>();
        const res = await app.request(`/api/v1/entries/${id}`, { method: "DELETE" }, env);
        expect(res.status).toBe(401);
    });

    it("makes the entry unreadable afterwards", async () => {
        const { id } = await (await postBlob("delete-me")).json<{ id: string; }>();

        const del = await app.request(`/api/v1/entries/${id}`, {
            method: "DELETE",
            headers: { Authorization: ADMIN },
        }, env);
        expect(del.status).toBe(204);

        expect((await app.request(`/api/v1/blobs/${id}`, {}, env)).status).toBe(404);
        expect((await app.request(`/${id}`, {}, env)).status).toBe(404);
    });
});

describe("misses", () => {
    it("404s an unknown id on both read paths", async () => {
        expect((await app.request("/api/v1/blobs/doesnotexist", {}, env)).status).toBe(404);
        expect((await app.request("/nosuchid1", {}, env)).status).toBe(404);
    });

    it("404s an over-long id instead of hitting KV", async () => {
        expect((await app.request(`/${"a".repeat(200)}`, {}, env)).status).toBe(404);
    });

    it("reports PUT as not implemented so the future API shape is reserved", async () => {
        const res = await app.request("/api/v1/blobs/abc12345", { method: "PUT", body: "x" }, env);
        expect(res.status).toBe(501);
    });
});
