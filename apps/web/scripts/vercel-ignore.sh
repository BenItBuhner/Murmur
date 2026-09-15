#!/bin/sh
# Vercel's Ignored Build Step for the murmur-web project (vercel.json "ignoreCommand").
#
# Vercel runs this in the project's Root Directory (apps/web) inside its shallow clone
# (git clone --depth=10) before installing anything. Exit 0 skips the deployment, any
# other exit code builds it. Deploy when:
#   - the branch is main (the production deployment always follows main), or
#   - anything under apps/web or packages/backend (the site imports the backend's
#     generated types) changed since the last successful deployment of this branch,
#     or since the previous commit when that deployment is unknown or too old to be
#     in the clone (VERCEL_GIT_PREVIOUS_SHA is empty on a branch's first push).
# Every other push is skipped, so a change to the desktop or Android app does not
# spend a build. When in doubt (system variables off, git unable to answer) it builds.
set -u

ref="${VERCEL_GIT_COMMIT_REF:-}"
if [ -z "$ref" ]; then
  echo "vercel-ignore: VERCEL_GIT_COMMIT_REF is not set (enable system environment variables on the project); building"
  exit 1
fi
if [ "$ref" = "main" ] || [ "${VERCEL_ENV:-}" = "production" ]; then
  echo "vercel-ignore: $ref is the production branch; building"
  exit 1
fi

base="${VERCEL_GIT_PREVIOUS_SHA:-}"
if [ -n "$base" ] && git cat-file -e "$base^{commit}" 2>/dev/null; then
  since="the last deployment of $ref ($base)"
else
  base="HEAD^"
  since="the previous commit"
fi

# --quiet exits 0 with no differences, 1 with differences and 128 when git cannot
# compare (a single-commit repository, an object outside the clone): only 0 skips.
if git diff --quiet "$base" HEAD -- . ../../packages/backend; then
  echo "vercel-ignore: nothing under apps/web or packages/backend changed since $since; skipping"
  exit 0
fi
echo "vercel-ignore: apps/web or packages/backend changed since $since; building"
exit 1
