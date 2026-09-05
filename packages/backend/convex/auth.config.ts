/**
 * Clerk is the identity provider. Every client (desktop, Android) obtains a Clerk JWT minted from
 * the JWT template named `convex` and hands it to the Convex client; Convex validates it against
 * Clerk's JWKS.
 *
 * CLERK_JWT_ISSUER_DOMAIN is the Clerk Frontend API URL of the instance, e.g.
 * https://clerk.murmur.app (production) or https://your-slug.clerk.accounts.dev (development).
 * Set it in the Convex dashboard (Settings -> Environment Variables) for each deployment.
 */
export default {
  providers: [
    {
      domain: process.env.CLERK_JWT_ISSUER_DOMAIN,
      applicationID: 'convex'
    }
  ]
}
