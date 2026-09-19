/**
 * `blob` is anonymous, browser-written ciphertext and is NEVER redirected to.
 * `link` is a redirect target and can only be created with ADMIN_SECRET.
 *
 * The split is the whole security model: redirect capability is what an abuser
 * wants, so it lives behind the one endpoint a stranger cannot reach. The kind is
 * therefore decided by the endpoint and written into the record — a client-supplied
 * field (`meta.type` and friends) would let an anonymous writer promote itself.
 */
export type EntryKind = "blob" | "link";

/**
 * Declared by hand rather than taken from the generated `Env`: `wrangler types`
 * only sees vars and bindings in wrangler.jsonc, so the two secrets below would be
 * missing, and TURNSTILE_SECRET's optionality is load-bearing (see verifyTurnstile).
 */
export type Bindings = {
    /**
     * The raw platform binding. Nothing outside the cloudflareKv adapter should touch
     * it — handlers take an EntryStore, so this stays the narrow seam where hop knows
     * which vendor it is deployed on.
     */
    HOP_KV: KVNamespace;
    ALLOWED_ORIGINS: string;
    ADMIN_SECRET: string;
    /** Absent by default — Turnstile stays off until abuse justifies its UX cost. */
    TURNSTILE_SECRET?: string;
};

export type EntryRecord = {
    id: string;
    kind: EntryKind;
    /** blob: base64url(iv ‖ ciphertext). link: an http(s) URL. */
    payload: string;
    /**
     * Bearer secret for `PUT` / `DELETE /api/v1/blobs/:id`, handed to the creator
     * once as `editToken` and never returned by any read. Optional only because
     * records written before it existed have none — those can never be updated.
     */
    ownerToken?: string;
    /** epoch milliseconds; present only once the blob has been re-uploaded via PUT. */
    updatedAt?: number;
    meta: Record<string, unknown>;
    /** epoch milliseconds — same unit as expiresAt, deliberately. */
    createdAt: number;
    expiresAt: number;
};
