import {
    describe,
    expect,
    it,
} from "vitest";
import type { EntryStore } from "../src/lib/store";
import { claimKey } from "../src/lib/store";

/**
 * A store built from a plain Map, with no Cloudflare anything. That it satisfies
 * EntryStore at all is the point of these tests: the interface is small enough to
 * implement against any backend, which is the property that keeps a migration
 * cheap. TTLs are recorded rather than enforced — expiry is the backend's job.
 */
function memoryStore(atomic: boolean): EntryStore & { ttls: Map<string, number>; } {
    const data = new Map<string, string>();
    const ttls = new Map<string, number>();

    const store: EntryStore & { ttls: Map<string, number>; } = {
        ttls,
        get: key => Promise.resolve(data.get(key) ?? null),
        put: (key, value, ttlSeconds) => {
            data.set(key, value);
            ttls.set(key, ttlSeconds);
            return Promise.resolve();
        },
        delete: key => {
            data.delete(key);
            ttls.delete(key);
            return Promise.resolve();
        },
    };

    // Stands in for Redis SET NX / a unique constraint: the check and the write
    // cannot be interleaved, which is exactly what Workers KV cannot promise.
    if (atomic) {
        store.putIfAbsent = (key, value, ttlSeconds) => {
            if (data.has(key)) return Promise.resolve(false);
            data.set(key, value);
            ttls.set(key, ttlSeconds);
            return Promise.resolve(true);
        };
    }

    return store;
}

describe.each([
    ["a store without putIfAbsent (the Workers KV shape)", false],
    ["a store with putIfAbsent (the Redis/Postgres shape)", true],
])("claimKey against %s", (_label, atomic) => {
    it("writes the value and reports the claim", async () => {
        const store = memoryStore(atomic);

        await expect(claimKey(store, "entry:abc", "first", 60)).resolves.toBe(true);
        await expect(store.get("entry:abc")).resolves.toBe("first");
    });

    it("refuses a key somebody already holds, leaving the original untouched", async () => {
        const store = memoryStore(atomic);
        await claimKey(store, "entry:abc", "first", 60);

        await expect(claimKey(store, "entry:abc", "second", 60)).resolves.toBe(false);
        // The whole reason claimKey exists: a losing writer must not clobber the winner.
        await expect(store.get("entry:abc")).resolves.toBe("first");
    });

    it("passes the ttl through to the backend", async () => {
        const store = memoryStore(atomic);
        await claimKey(store, "entry:abc", "first", 1234);

        expect(store.ttls.get("entry:abc")).toBe(1234);
    });
});
