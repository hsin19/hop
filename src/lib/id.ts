import { customAlphabet } from "nanoid";

const BASE62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** 8 chars of base62 ≈ 2.18e14 combinations — short enough for a QR, wide enough not to enumerate. */
export const generateId = customAlphabet(BASE62, 8);

/** Reserved for updatable links. 32 chars because this one is a bearer secret, not a lookup key. */
export const generateOwnerToken = customAlphabet(BASE62, 32);
