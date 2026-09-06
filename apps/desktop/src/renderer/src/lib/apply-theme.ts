import type { ResolvedTheme } from '@shared/theme'

/**
 * Write a resolved palette onto a document root: one custom property per token, the `.dark`
 * class Tailwind's dark variant keys off, and `color-scheme` so native widgets (scrollbars, the
 * colour picker) match. Used by both the settings window and the overlay.
 */
export function applyTheme(root: HTMLElement, theme: ResolvedTheme): void {
  for (const [token, value] of Object.entries(theme.vars))
    root.style.setProperty(`--${token}`, value)
  root.classList.toggle('dark', theme.mode === 'dark')
  root.style.colorScheme = theme.mode
}
