# Ephemeris update feed

A private, GitHub-compatible release feed for the desktop updater. The Ephemeris repository is
private, so the anonymous GitHub Releases API the updater normally reads returns 404; builds made
with `VITE_EPHEMERIS_UPDATE_API_BASE=https://<worker>/<FEED_KEY>` read this feed instead.

- Cloudflare Worker `ephemeris-updates` (Workers Free) + a Workers KV namespace (free tier). R2 is
  not enabled on the account, so installers are stored as 24 MiB chunks (KV's cap is 25 MiB).
- Every path starts with the secret `FEED_KEY`; anything else is a 404. The key only lives in the
  Worker secret and in the `.env` of the machine that builds the desktop app (never in git).
- `GET /<key>/repos/<owner>/<name>/releases` returns the `releases` manifest in the GitHub
  API shape, with `digest: sha256:<hex>` per asset so the updater verifies each download.
- `GET /<key>/dl/<tag>/<file>` streams an asset.
- Uploads (`upload/...`, `manifest`) also need `Authorization: Bearer <PUBLISH_KEY>`.

## Deploy

`.github/workflows/deploy-ephemeris-updates.yml` deploys on push to main or by hand
(`gh workflow run deploy-ephemeris-updates.yml -R BenItBuhner/Murmur`), provisioning the KV namespace
on the first run, and generates the two keys once (kept in the namespace at `config:keys`, which the
Worker never serves). To hand
them to a publishing machine, run it with `-f recipient_key="$(cat pub.pem)"` (an RSA public key whose
private half stays on that machine), download the `feed-keys` artifact and decrypt it there
(RSA-OAEP, SHA-256).

## Publish a build

    EPHEMERIS_UPDATE_API_BASE=https://ephemeris-updates.<account>.workers.dev/<FEED_KEY> \
    EPHEMERIS_FEED_PUBLISH_KEY=... \
      node scripts/publish.mjs 0.1.2 Ephemeris-0.1.2-x64-setup.exe --notes "..."

Uploads go through the Worker in 24 MiB chunks, so no wrangler or Cloudflare login is
needed on the publishing machine.

This lives in the Murmur repository because it reuses Murmur's Cloudflare account and deploy
secrets; it is listed with the other shared pieces in the retire-Murmur doc.
