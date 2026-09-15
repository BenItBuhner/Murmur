/**
 * Clerk is the identity provider. Every client (desktop, Android) obtains a Clerk JWT minted from
 * the JWT template named `convex` and hands it to the Convex client; Convex validates it against
 * Clerk's JWKS.
 *
 * CLERK_JWT_ISSUER_DOMAIN is the Clerk Frontend API URL of the instance, e.g.
 * https://clerk.murmur.app (production) or https://your-slug.clerk.accounts.dev (development).
 * Set it in the Convex dashboard (Settings -> Environment Variables) for each deployment.
 *
 * MURMUR_TEST_JWT_ISSUER + MURMUR_TEST_JWKS_URL (both required, never set on production) let a
 * development deployment additionally trust RS256 tokens minted by a test issuer, the way the live
 * suites (apps/desktop/tests/live, the Android live tests) sign in without a Clerk instance. The
 * tokens carry the same `aud: "convex"` and `sub` claims Clerk's template would.
 */
const providers: Array<Record<string, string | undefined>> = [
  {
    domain: process.env.CLERK_JWT_ISSUER_DOMAIN,
    applicationID: 'convex'
  }
]

if (process.env.MURMUR_TEST_JWT_ISSUER && process.env.MURMUR_TEST_JWKS_URL) {
  providers.push({
    type: 'customJwt',
    applicationID: 'convex',
    issuer: process.env.MURMUR_TEST_JWT_ISSUER,
    jwks: process.env.MURMUR_TEST_JWKS_URL,
    algorithm: 'RS256'
  })
}

export default { providers }
