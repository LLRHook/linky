# Truth Social relay

Truth Social's bot protection decides per client and network whether its public status API (`/api/v1/statuses/ID`) answers. On October 26, 2026 the hosted bot's own HTTPS client was accepted, but curl and `fetch()` from the same server, and all twelve Vercel regions tried, received HTTP 403. Requests from a Cloudflare Worker succeeded for every account tried, including image, multi-image and video posts. Signed ActivityPub fetches are refused: Truth Social does not resolve keys from servers it does not already know.

Linky asks the status API first. The relay is the fallback for hosts the API refuses, or for when Truth Social tightens its rules, so that cards keep their media and video links for every account.

The relay is a Cloudflare Worker that serves one route to Linky:

```
GET /status/<numeric id>
Authorization: Bearer <RELAY_TOKEN>
```

It fetches `https://truthsocial.com/api/v1/statuses/<id>` signed out and returns the JSON body unchanged. Truth Social's 404 and 410 pass through; blocks, redirects, non-JSON and bodies over 512 KiB return 502. Other methods, paths and query strings are refused before any upstream request. The relay never forwards the caller's token. Successful upstream responses may be cached by Cloudflare for 60 seconds. Linky still validates every field itself (see [article previews](article-previews.md#truth-social-posts)).

The source is [`workers/truth-social-relay/worker.mjs`](../workers/truth-social-relay/worker.mjs). Tests: `node --test tests/truth-social-relay.test.mjs`.

## Deploy

The Workers free plan is enough: Linky makes at most one relay request per Truth Social link, within the article rate limits.

1. From `workers/truth-social-relay`, sign in with `npx wrangler login` and deploy with `npx wrangler deploy`. Wrangler prints the `https://linky-truth-social-relay.<account>.workers.dev` origin.
2. Generate a secret, for example `node -e "console.log(require('crypto').randomBytes(36).toString('base64url'))"`, and store it with `npx wrangler secret put RELAY_TOKEN`. Until a token of at least 32 characters is set, the relay answers 503.
3. On the bot host, set `TRUTH_SOCIAL_RELAY_URL` to the origin and `TRUTH_SOCIAL_RELAY_TOKEN` to the same secret in `.env`, then restart the container. The startup log line `Social link replacement ready…` reports `truthSocialRelay: true`.
4. Check it: `curl -H "Authorization: Bearer $TOKEN" https://…workers.dev/status/117497314507062631` returns status JSON, and the same request without the header returns 401.

To rotate the secret, set the new value in both places and restart the bot. To disable the relay, clear both variables; Linky falls back to the other sources.

If Truth Social starts blocking Cloudflare Workers too, relay responses become 502 and Linky continues with its other sources. The checks in step 4 show which side failed.
