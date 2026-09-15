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

/**
 * An environment variable the deployment may not have. While this file is evaluated, reading an
 * unset variable through `process.env` does not yield undefined: the backend raises
 * AuthConfigMissingEnvironmentVariable and the push fails, and `in` / `Object.keys` never see
 * deployment variables. The raise is an ordinary exception, so catching it is the one way to make
 * a variable optional here; verified against the local backend both ways (set: the provider is
 * pushed; unset: the push succeeds without it).
 */
function optional(name: string): string | undefined {
  try {
    return process.env[name]
  } catch {
    return undefined
  }
}

const providers: Array<Record<string, string | undefined>> = [
  {
    domain: process.env.CLERK_JWT_ISSUER_DOMAIN,
    applicationID: 'convex'
  }
]

const testIssuer = optional('MURMUR_TEST_JWT_ISSUER')
const testJwks = optional('MURMUR_TEST_JWKS_URL')
if (testIssuer && testJwks) {
  providers.push({
    type: 'customJwt',
    applicationID: 'convex',
    issuer: testIssuer,
    jwks: testJwks,
    algorithm: 'RS256'
  })
}

export default { providers }
