/*
 * The desktop app's information architecture, as data, so the sidebar and the tests read one
 * source. The same five destinations and the same names as the Android drawer: Home, History,
 * Dictionary and snippets, Style, then the settings; on a desktop there is room to list the
 * settings pages in the rail itself, under one "Settings" heading, instead of behind a hub screen.
 * The account is the rail's foot, not an item in the list.
 */

export type Route =
  | 'home'
  | 'history'
  | 'dictionary'
  | 'style'
  | 'providers'
  | 'shortcuts'
  | 'audio'
  | 'button'
  | 'appearance'
  | 'general'
  | 'account'

export interface NavItem {
  id: Route
  label: string
  /** Starts a new group with this heading. */
  group?: string
}

/** The rail, top to bottom. */
export const NAV: readonly NavItem[] = [
  { id: 'home', label: 'Home' },
  { id: 'history', label: 'History' },
  { id: 'dictionary', label: 'Dictionary and snippets', group: 'Personalize' },
  { id: 'style', label: 'Style' },
  { id: 'providers', label: 'Speech model', group: 'Settings' },
  { id: 'shortcuts', label: 'Shortcuts' },
  { id: 'audio', label: 'Microphone' },
  { id: 'button', label: 'Dictation button' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'general', label: 'General' }
]

/** Every screen the shell can show: the rail's items and the account, reached from the rail's foot. */
export const ROUTES: ReadonlySet<Route> = new Set<Route>([...NAV.map((n) => n.id), 'account'])

/** Names older parts of the app (the tray, deep links) may still use for a screen. */
const LEGACY: Readonly<Record<string, Route>> = {
  snippets: 'dictionary',
  models: 'providers',
  settings: 'general'
}

/** The screen a route name stands for, or null for one the shell does not know. */
export function resolveRoute(name: string): Route | null {
  if (ROUTES.has(name as Route)) return name as Route
  return LEGACY[name] ?? null
}
