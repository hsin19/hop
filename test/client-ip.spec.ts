import {
    describe,
    expect,
    it,
} from "vitest";
import { clientIp } from "../src/lib/client-ip";

const from = (h: Record<string, string>) => clientIp(new Headers(h));

describe("clientIp", () => {
    it("prefers CF-Connecting-IP, which is the one Cloudflare's edge sets itself", () => {
        expect(from({
            "CF-Connecting-IP": "203.0.113.1",
            "X-Real-IP": "198.51.100.1",
            "X-Forwarded-For": "198.51.100.2",
        })).toBe("203.0.113.1");
    });

    // The point of the whole helper: off Cloudflare, CF-Connecting-IP is simply absent.
    it("falls back to X-Real-IP when running behind a non-Cloudflare proxy", () => {
        expect(from({ "X-Real-IP": "198.51.100.1" })).toBe("198.51.100.1");
    });

    it("takes only the first hop of X-Forwarded-For", () => {
        // The chain is client, then each proxy — later entries are infrastructure,
        // not the caller, so appending them would attribute the request to a proxy.
        expect(from({ "X-Forwarded-For": "203.0.113.9, 70.41.3.18, 150.172.238.178" }))
            .toBe("203.0.113.9");
    });

    it("trims the whitespace X-Forwarded-For conventionally carries", () => {
        expect(from({ "X-Forwarded-For": "  203.0.113.9  , 70.41.3.18" })).toBe("203.0.113.9");
    });

    it("returns undefined rather than an empty string when nothing identifies the caller", () => {
        // verifyTurnstile omits remoteip entirely on a falsy value, so "" would be
        // indistinguishable from absent here but is not worth relying on.
        expect(from({})).toBeUndefined();
        expect(from({ "X-Forwarded-For": "" })).toBeUndefined();
        expect(from({ "X-Forwarded-For": "   " })).toBeUndefined();
    });
});
