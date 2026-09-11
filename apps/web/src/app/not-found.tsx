import { ButtonLink } from '@/components/ui/button'
import { Section } from '@/components/ui/section'

export default function NotFound() {
  return (
    <Section className="py-28 sm:py-40">
      <div className="mx-auto max-w-xl text-center">
        <div className="eyebrow">Nothing here</div>
        <h1 className="serif-display mt-4 text-[3rem] sm:text-[4rem]">
          That page did not make it into the transcript.
        </h1>
        <p className="mt-5 text-[17px] text-muted-foreground">
          The address may have changed. The downloads, pricing and your account are one step away.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <ButtonLink href="/">Back to the start</ButtonLink>
          <ButtonLink href="/download" variant="paper">
            Download Murmur
          </ButtonLink>
        </div>
      </div>
    </Section>
  )
}
