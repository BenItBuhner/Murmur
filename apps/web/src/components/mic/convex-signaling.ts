import type { ConvexReactClient } from 'convex/react'
import type { Id } from '@backend/_generated/dataModel'
import { api } from '@/lib/backend-api'
import { SignalingError, type AnswerSignal, type Signaling } from '@/lib/phone-mic'

/**
 * `Signaling` over the signed-in Convex client: one query to list the desktops, one offer, a
 * watch on this phone's inbox that ends as soon as the answer is in, and one call to delete it.
 */
export function convexSignaling(client: ConvexReactClient): Signaling {
  return {
    receivers: () => client.query(api.micLink.receivers, {}),
    offer: async (args) => {
      await client.mutation(api.micLink.offer, args)
    },
    waitForAnswer: (deviceId, linkId, timeoutMs) =>
      new Promise<AnswerSignal>((resolve, reject) => {
        const watch = client.watchQuery(api.micLink.inbox, { deviceId })
        let unsubscribe: () => void = () => {}
        let settled = false
        const finish = (fn: () => void): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          unsubscribe()
          fn()
        }
        const timer = setTimeout(
          () =>
            finish(() =>
              reject(
                new SignalingError(
                  'The computer did not answer. Check that Murmur is running there and signed in to this account.'
                )
              )
            ),
          timeoutMs
        )
        const check = (): void => {
          let list: ReturnType<typeof watch.localQueryResult>
          try {
            list = watch.localQueryResult()
          } catch (err) {
            finish(() => reject(err))
            return
          }
          const hit = list?.find((s) => s.linkId === linkId && s.kind !== 'offer')
          if (hit) finish(() => resolve(hit))
        }
        unsubscribe = watch.onUpdate(check)
        check()
      }),
    take: async (id) => {
      await client.mutation(api.micLink.take, { id: id as Id<'micSignals'> })
    }
  }
}
