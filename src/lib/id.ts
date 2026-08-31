import { customAlphabet } from "nanoid";

const BASE62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** 8 chars of base62 ≈ 2.18e14 combinations — short enough for a QR, wide enough not to enumerate. */
export const generateId = customAlphabet(BASE62, 8);

/** Reserved for updatable links. 32 chars because this one is a bearer secret, not a lookup key. */
export const generateOwnerToken = customAlphabet(BASE62, 32);

/**
 * Best-effort collision check. KV has no atomic compare-and-set, so a race window
 * remains, but without this a collision silently overwrites somebody's entry —
 * a failure that is invisible to both the writer and the original owner.
 */
export async function generateUniqueId(kv: KVNamespace): Promise<string> {
    for (let attempt = 0; attempt < 3; attempt++) {
        const id = generateId();
        if (await kv.get(`entry:${id}`) === null) return id;
    }
    throw new Error("Failed to generate a unique id");
}
