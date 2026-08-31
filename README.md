# hop

Short links and end-to-end encrypted blob relay, on Cloudflare Workers + KV.
Runs at `hop.hsin19.com`.

Two things share one store, at deliberately different trust levels:

- **blobs** — anonymous ciphertext drops from a browser. hop never sees plaintext
  and **never redirects to them**.
- **links** — ordinary short links. Only creatable with `ADMIN_SECRET`, and the only
  kind `GET /:code` will redirect to.

## Why the split

Redirect capability is what an abuser wants: an open redirect on `hsin19.com` is a
free phishing hop and can get the apex domain flagged by Safe Browsing, taking every
other service on it down with it. Storing an opaque encrypted blob is not worth
stealing. So the write endpoint decides the kind and records it — a client-supplied
field would let an anonymous writer promote its blob into a redirect.

`test/index.spec.ts` pins this: a blob whose plaintext is `https://phishing.example/`
must come back as JSON, never as a 302.

## Encryption is the caller's job

hop stores whatever string it is handed. The end-to-end encryption lives in the
client (show-me-way): plaintext is compressed, encrypted with AES-GCM-128, and only
the ciphertext is uploaded. **The key never reaches hop** — it travels in the URL
fragment of the share link, which browsers do not send in requests. A log line
holding both an id and its key would be a plaintext payload, so nothing here should
ever accept, log, or store a key.

## API

| Method   | Path                  | Auth                  | Notes                                                                                                                                                |
| -------- | --------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/health`             | —                     | `{ status, service, time }`                                                                                                                          |
| `POST`   | `/api/v1/blobs`       | Turnstile (optional)  | Body is the payload as `text/plain`. 64,000 char cap, default TTL 90 days, `?ttl=<seconds>` to override. Returns `{ id, editToken, expiresAt, ttl }` |
| `GET`    | `/api/v1/blobs/:id`   | —                     | The record, minus `ownerToken`                                                                                                                       |
| `PUT`    | `/api/v1/blobs/:id`   | —                     | Reserved for updatable links; currently `501`                                                                                                        |
| `POST`   | `/api/v1/links`       | `Bearer ADMIN_SECRET` | `{ url, ttl?, meta? }`. `url` must be `http(s)`                                                                                                      |
| `DELETE` | `/api/v1/entries/:id` | `Bearer ADMIN_SECRET` | Revoke an entry                                                                                                                                      |
| `GET`    | `/:code`              | —                     | `302` for a link; the JSON record for a blob                                                                                                         |

Uploads are `text/plain` on purpose: it keeps them CORS-simple, so a browser skips
the preflight `OPTIONS` — one fewer mobile round trip on the request sitting between
a user tapping "share" and seeing a link.

TTLs are clamped to 60s–365d. `createdAt` and `expiresAt` are both epoch
**milliseconds**.

```bash
# store ciphertext
curl -X POST https://hop.hsin19.com/api/v1/blobs \
  -H 'Content-Type: text/plain' --data-binary 'BASE64URL_CIPHERTEXT'

# create a short link
curl -X POST https://hop.hsin19.com/api/v1/links \
  -H "Authorization: Bearer $ADMIN_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com/somewhere/long"}'
```

## Development

```bash
pnpm install
pnpm dev          # wrangler dev
pnpm run check    # format, lint, typecheck, test, build — run this before pushing
```

`check` rewrites files (`dprint fmt`), so expect a clean run to have edited your tree.

## Setup

One-time, per environment:

1. `wrangler kv namespace create HOP_KV`, then put the id into `wrangler.jsonc`.
2. `wrangler secret put ADMIN_SECRET`
3. Bind the custom domain: Workers → Settings → Domains & Routes → `hop.hsin19.com`.
4. Add a WAF rate-limiting rule — this, not Turnstile, is the first line of defence
   for the anonymous write path:
   - Expression: `http.request.uri.path eq "/api/v1/blobs" and http.request.method eq "POST"`
   - Limit: 10 requests per minute per IP
5. Repo settings: `secrets.CLOUDFLARE_API_TOKEN`, `secrets.ADMIN_SECRET`, and
   `vars.CLOUDFLARE_ACCOUNT_ID` (an account id is not a secret, matching the other
   repos here).

`TURNSTILE_SECRET` is deliberately unset. `verifyTurnstile` waves requests through
when it is absent, so turning the challenge on is `wrangler secret put
TURNSTILE_SECRET` and nothing else. Leave it off until abuse justifies putting a
challenge in front of a share button.

## Conventions

Follows the same setup as the other TypeScript repos here: pnpm, dprint (4-space TS,
double quotes, semicolons), ESLint flat config, and a `check` script that CI mirrors
as one step per check.
