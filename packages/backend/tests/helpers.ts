import { convexTest } from 'convex-test'
import type { UserIdentity } from 'convex/server'
import schema from '../convex/schema'

export const modules = import.meta.glob('../convex/**/*.*s')

export function setup() {
  return convexTest(schema, modules)
}

export const ada: Partial<UserIdentity> = {
  subject: 'user_ada',
  email: 'ada@example.com',
  name: 'Ada Lovelace',
  pictureUrl: 'https://img.clerk.com/ada.png'
}

export const bob: Partial<UserIdentity> = {
  subject: 'user_bob',
  email: 'bob@example.com',
  givenName: 'Bob',
  familyName: 'Builder'
}
