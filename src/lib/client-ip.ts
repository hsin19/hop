/**
 * The caller's IP, whichever platform this is deployed on.
 *
 * CF-Connecting-IP is Cloudflare's own and is the trustworthy one there because the
 * edge sets it, but it exists nowhere else; the fallbacks are what other proxies
 * populate. X-Forwarded-For is a client-to-origin chain, so only its first entry is
 * the original caller.
 *
 * A spoofable header is acceptable *here specifically*: the value is only a hint
 * passed to Turnstile, and nothing is authorised on the strength of it. Do not
 * reuse this for rate limiting or access control without a trusted-proxy check.
 */
export function clientIp(headers: Headers): string | undefined {
    const direct = headers.get("CF-Connecting-IP") ?? headers.get("X-Real-IP");
    if (direct) return direct;
    return headers.get("X-Forwarded-For")?.split(",")[0]?.trim() || undefined;
}
