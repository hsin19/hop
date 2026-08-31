const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * Verify a Turnstile token, or wave the request through when no secret is
 * configured. That "off by default" branch is the shipped behaviour: putting a
 * challenge in front of a travel app's share button costs real UX, while the abuse
 * it prevents (rate-limited, size-capped ciphertext) is cheap to absorb. Setting
 * TURNSTILE_SECRET is the escalation, and needs no code change.
 */
export async function verifyTurnstile(
    secret: string | undefined,
    token: string,
    remoteIp: string | null | undefined,
): Promise<boolean> {
    if (!secret) return true;
    if (!token) return false;

    const form = new FormData();
    form.append("secret", secret);
    form.append("response", token);
    if (remoteIp) form.append("remoteip", remoteIp);

    try {
        const res = await fetch(SITEVERIFY, { method: "POST", body: form });
        // Annotated rather than res.json<T>(): that generic is a Cloudflare types
        // extension. Standard Response.json() returns any, which this annotation
        // narrows just as well, so the line compiles on and off platform alike.
        const data: { success?: boolean; } = await res.json();
        return data.success === true;
    } catch {
        // Fail closed: an unreachable siteverify means we cannot tell a human from a
        // bot, and the write is discretionary. The caller degrades to "try again".
        return false;
    }
}
