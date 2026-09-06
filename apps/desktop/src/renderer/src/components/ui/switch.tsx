import * as React from 'react'
import { Switch as SwitchPrimitive } from 'radix-ui'
import { cn } from '@renderer/lib/utils'

function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>): React.JSX.Element {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        'peer inline-flex h-[22px] w-9.5 shrink-0 items-center rounded-full border border-transparent transition-colors duration-200 outline-none focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input',
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-4 rounded-full bg-background ring-0 transition-transform duration-200 data-[state=checked]:translate-x-[18px] data-[state=unchecked]:translate-x-[3px]"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
