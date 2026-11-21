# Timeline store (CasaOS on bennett)

This is the disk the inference Worker uses for timeline wavs. Convex stores the transcript and the object key. The bucket is not public and there is no list route. Home Management deploys this on the existing host `bennett` and publishes it through the existing Cloudflare tunnel. Nothing in this folder contains a hostname or a secret.

## Container

From this directory on the CasaOS host:

```sh
export TIMELINE_STORE_SECRET='<at least 32 random characters>'
docker compose up -d --build
```

The container listens on port **8788**. Files live in the `timeline-audio` volume, under `/data/timeline` in the container. New writes are refused with HTTP 507 once the directory exceeds `TIMELINE_MAX_BYTES` (default 20 GB). The process also deletes files older than 7 days, which backs up the Worker's daily delete.

## Tunnel

Add one ingress on the existing Cloudflare tunnel for `bennett`. Do not open 8788 on the public internet.

- Hostname: a name you choose on a domain the tunnel already serves, for example `timeline.example.com`
- Service: `http://timeline-store:8788` if the tunnel connector is on the same Docker network, otherwise `http://127.0.0.1:8788`

There is no public listing. `/health` answers `ok` with no secret, and that is the only unauthenticated route.

## Worker secrets

Set these on the `murmur-inference` Worker. Do not commit them.

- `TIMELINE_STORE_URL` = `https://<the hostname above>`
- `TIMELINE_STORE_SECRET` = the same value as the container's `TIMELINE_STORE_SECRET`

Until both are set, the Worker still transcribes and saves the transcript. It just does not keep the wav.
