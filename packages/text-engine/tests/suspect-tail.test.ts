import { describe, expect, it } from 'vitest'
import { suspectTail } from '../src/hallucination'

describe('suspectTail', () => {
  it('flags the Nov 9 made-up ending', () => {
    const raw =
      "Yeah, yeah, I give my okay. By the way, the reason behind GitHub Actions not working is just because it's a private repository at the time and right now I've used all of my Actions minutes on GitHub and I'm not paying for that. I'm never going to pay for that. All tests, CI, and everything of the sort I think it's a good thing to do with the data, and I think it's really important to do with the data."
    expect(suspectTail(raw)).toBe(true)
  })
  it('passes what was said', () => {
    const said =
      "Yeah, I give my okay. By the way, the reason GitHub Actions isn't working is simply that it's a private repository at the moment, and right now I've used all of my Actions minutes on GitHub and I'm not paying for that. I'm never going to pay for that. All tests, CI, and everything of the sort should be done in the cloud threads for us instead, please."
    expect(suspectTail(said)).toBe(false)
  })
  it('passes a phrase the speaker used earlier too', () => {
    const t =
      'We need to ship the build today. There is a lot riding on it, the beta group is waiting, the store listing is ready, the screenshots are done and the release notes are written. Anyway the main thing is we need to ship the build today and then rest, because honestly we need to ship the build today.'
    expect(suspectTail(t)).toBe(false)
  })
})
