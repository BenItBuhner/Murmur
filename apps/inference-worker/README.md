# Murmur inference Worker

Murmur's managed inference gateway (`/v1/models`, `/v1/audio/transcriptions`, `/v1/chat/completions`,
`/v1/format`) as a Cloudflare Worker. It runs the exact handlers the Convex HTTP actions run
(`packages/backend/convex/lib/gatewayCore.ts`), so the apps only change their base URL, but the
audio and the provider round trips no longer go through Convex:

| Per dictation              | Convex gateway (before)                                      | Worker (after)                                  |
| -------------------------- | ------------------------------------------------------------ | ----------------------------------------------- |
| Audio bytes through Convex | yes (HTTP action buffers the clip)                           | no                                              |
| Convex function calls      | ~5-7 (http action x2, authorize x2, record x2, breaker)      | ~0 (grant cached 2 min, usage batched)          |
| Action compute             | waits on Groq for the whole transcription + format           | none                                            |

How it decides who may do what:

- **Session**: the bearer token is the Clerk session JWT the apps already send (template `convex`),
  verified against the Clerk instance's JWKS (RS256, `iss`, `aud=convex`, `exp`/`nbf`).
- **Allowance**: `POST <CONVEX_SITE_URL>/worker/grant` returns the account's plan state and whether
  speech / formatting are currently refused (same rules as `inference.authorize`, including trials and
  private testing). Cached per isolate for 2 minutes.
- **Usage**: buffered per isolate and sent to `POST <CONVEX_SITE_URL>/worker/usage`
  (`inference.recordBatch`) at most ~20 s after the first record or every 25 records.
- **Provider breaker**: per isolate, same thresholds as the Convex one.

Both `/worker/*` calls carry `Authorization: Bearer <MURMUR_WORKER_SECRET>`.

## Deploy

Deployed from `main` by `.github/workflows/deploy-inference-worker.yml`: a push that touches this
folder or the backend gateway handlers it runs (`packages/backend/convex/lib`), or a manual
`workflow_dispatch`, installs, re-applies the repository secrets and deploys with wrangler. The
first run creates the Worker (as a draft with its secrets, then the code); secrets persist across
deploys, so rotating one is a matter of updating the repository secret and pushing.

- Repository secrets (the same values the Convex deployment carries): `MURMUR_WORKER_SECRET`,
  `MURMUR_INFERENCE_STT_KEY`, `MURMUR_INFERENCE_LLM_KEY`.
- Public configuration (`CLERK_JWT_ISSUER_DOMAIN`, `CONVEX_SITE_URL`, the `MURMUR_INFERENCE_*_URL` /
  `_MODEL` values, `MURMUR_SITE_URL`) lives in `wrangler.jsonc`. Leave `MURMUR_BILLING_ENABLED` unset.
- The Workers Free plan is enough: no bindings, ~25 KB gzipped.

The Convex side must already be deployed (it provides `/worker/grant`, `/worker/usage`,
`history.since`, `stats.recordMany`, the `historyEntries.by_user` index) and carry the same
`MURMUR_WORKER_SECRET` in its environment.

Left for the client switch, when the time comes:

1. Build the apps with `VITE_MURMUR_INFERENCE_URL` (desktop) / `MURMUR_INFERENCE_URL` (Android) set
   to the Worker's origin. Older app builds keep using the Convex routes.
2. Once no supported build uses them, set `MURMUR_CONVEX_GATEWAY=off` in Convex to switch the old
   `/v1/*` HTTP actions off (they stay in the code).

## Checks

```sh
npm ci && (cd ../../packages/backend && npm ci)   # the Worker imports the backend's gateway code
npm run typecheck && npm test
```
