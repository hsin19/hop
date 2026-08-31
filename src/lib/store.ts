/**
 * The storage surface hop actually needs: string values, a TTL, three operations.
 *
 * Every candidate backend — Workers KV, Redis, Deno KV, DynamoDB, a single Postgres
 * table — offers at least this much. Keeping the handlers talking to this interface
 * rather than to KVNamespace is what makes leaving Cloudflare a rewrite of one
 * adapter instead of a rewrite of every route.
 */
export interface EntryStore {
    get(key: string): Promise<string | null>;
    put(key: string, value: string, ttlSeconds: number): Promise<void>;
    delete(key: string): Promise<void>;
    /**
     * Write only if `key` is still unused, reporting whether the write happened.
     *
     * Optional because Workers KV genuinely cannot do it — it has no compare-and-set,
     * so {@link cloudflareKv} omits this and {@link claimKey} degrades. A backend that
     * *can* do it atomically (Redis `SET NX`, a Postgres unique constraint, a Durable
     * Object) should implement it, and id allocation becomes collision-proof with no
     * other change. The point of declaring it here is that KV's limitation stays in
     * the adapter instead of hardening into a permanent property of the app.
     */
    putIfAbsent?(key: string, value: string, ttlSeconds: number): Promise<boolean>;
}

/**
 * Claim `key` for `value`, returning false if somebody already holds it.
 *
 * Atomic when the store supports it. Otherwise this checks and then writes, which
 * can lose a race in the gap between the two and overwrite the entry that got there
 * first — an invisible failure for both writers. That is a real defect, not just a
 * slower path; it is simply the best Workers KV allows, and it disappears the moment
 * the store behind it grows a `putIfAbsent`.
 */
export async function claimKey(
    store: EntryStore,
    key: string,
    value: string,
    ttlSeconds: number,
): Promise<boolean> {
    if (store.putIfAbsent) return store.putIfAbsent(key, value, ttlSeconds);
    if (await store.get(key) !== null) return false;
    await store.put(key, value, ttlSeconds);
    return true;
}

/**
 * The only adapter that exists today, and the only code in src/ that names a
 * Cloudflare type. Porting hop means writing a sibling of this function.
 */
export function cloudflareKv(kv: KVNamespace): EntryStore {
    return {
        get: key => kv.get(key),
        put: async (key, value, ttlSeconds) => {
            await kv.put(key, value, { expirationTtl: ttlSeconds });
        },
        delete: key => kv.delete(key),
        // No putIfAbsent on purpose: KV has no atomic compare-and-set, and faking one
        // here would promise a guarantee the backend cannot keep.
    };
}
