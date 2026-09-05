import { anyApi } from 'convex/server'
import type { api as BackendApi } from '@backend/_generated/api'

/**
 * Typed handle on the backend's public functions. The generated `api` object is a proxy that builds
 * function references from property paths, so the runtime value comes from this app's own `convex`
 * package while the types come from packages/backend - the desktop cannot drift from the backend
 * without failing to typecheck.
 */
export const api = anyApi as unknown as typeof BackendApi
