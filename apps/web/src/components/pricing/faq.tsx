import { Surface } from '@/components/ui/surface'
import { FAQ } from '@/lib/pricing'

export function Faq() {
  return (
    <div className="mx-auto max-w-3xl">
      <div className="text-center">
        <div className="eyebrow">Questions</div>
        <h2 className="serif-display mt-4 text-[2.25rem] sm:text-[3rem]">
          The fine print, without the fine print.
        </h2>
      </div>
      <Surface radius={28} padding={8} className="mt-10">
        <div className="grid">
          {FAQ.map((item) => (
            <details
              key={item.q}
              className="group rounded-(--ri) transition-colors duration-200 open:bg-secondary"
            >
              <summary className="flex cursor-pointer list-none items-center justify-between gap-6 px-5 py-4 text-[16px] font-medium tracking-tight [&::-webkit-details-marker]:hidden">
                <span>{item.q}</span>
                <span
                  aria-hidden
                  className="relative inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-secondary text-muted-foreground transition-transform duration-200 group-open:rotate-45 group-open:bg-card"
                >
                  <svg width="12" height="12" viewBox="0 0 12 12">
                    <path
                      d="M6 1v10M1 6h10"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                    />
                  </svg>
                </span>
              </summary>
              <p className="px-5 pt-0 pb-5 text-[15px] leading-relaxed text-pretty text-muted-foreground">
                {item.a}
              </p>
            </details>
          ))}
        </div>
      </Surface>
    </div>
  )
}
