/*
 * The badge set (#184), shared by the page badge, the popup and the legend.
 *
 * Two things are said, by two different means:
 *   colour    — the verdict: green verified, purple verified and AI-made,
 *               yellow signer not trusted, red changed after signing.
 *   indicator — upper right, only when it adds something: a lock when the
 *               credential is durable (a registry holds a copy), an arrow when a
 *               stripped credential was found again, a question mark when it was
 *               not, an exclamation mark when the check itself failed.
 * No credentials is a white teardrop with a red outline and slash.
 * At the smallest size the CR letters are dropped: colour and indicator only.
 *
 * Free of imports and side effects: the content script, the popup and the tests
 * all use it. The art and its plain-language explanation live together so they
 * cannot drift apart. Designs: art/badges.pen, "Badge system v3".
 */

export const COLOURS = {
  green: '#3DBE5A',
  purple: '#A78BFA',
  yellow: '#FACC15',
  red: '#F26B6B',
  blue: '#60A5FA',
  slate: '#94A3B8',
  slash: '#D92D20'
} as const

export type BadgeStatus =
  | 'success' | 'success-durable'
  | 'ai-success' | 'ai-success-durable'
  | 'warning' | 'warning-durable'
  | 'error' | 'error-durable' | 'ai-error'
  | 'stripped' | 'stripped-unrecovered'
  | 'no-credentials' | 'unavailable'

type Glyph = 'lock' | 'recover' | 'question' | 'alert'

const PIN = 'M1.56 18c0-9.08 7.361-16.44 16.441-16.44s16.443 7.362 16.443 16.442V34.44H18C8.92 34.44 1.56 27.08 1.56 18Z'
const CR = 'M13.665 26.483c-4.07 0-6.61-3.189-6.61-6.973 0-3.785 2.54-6.973 6.61-6.973 3.292 0 5.522 2.152 6.118 4.951h-3.318c-.441-1.244-1.478-1.996-2.8-1.996-2.048 0-3.396 1.607-3.396 4.018s1.348 4.018 3.396 4.018c1.374 0 2.437-.804 2.852-2.126h3.292c-.545 2.878-2.8 5.08-6.144 5.08M21.12 26.12V12.9h3.11v1.426c.726-.96 1.866-1.582 3.577-1.582h.804v3.06h-.83c-1.166 0-1.892.258-2.436.75-.622.52-.985 1.375-.985 2.67v6.896z'

// Stroke glyphs on a 24-unit grid.
const GLYPHS: Record<Glyph, string> = {
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  recover: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  question: '<path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  alert: '<path d="M12 6v8"/><path d="M12 18h.01"/>'
}

const FILL: Record<BadgeStatus, string> = {
  success: COLOURS.green,
  'success-durable': COLOURS.green,
  'ai-success': COLOURS.purple,
  'ai-success-durable': COLOURS.purple,
  warning: COLOURS.yellow,
  'warning-durable': COLOURS.yellow,
  error: COLOURS.red,
  'error-durable': COLOURS.red,
  'ai-error': COLOURS.red,
  stripped: COLOURS.green,
  'stripped-unrecovered': COLOURS.blue,
  'no-credentials': '#FFFFFF',
  unavailable: COLOURS.slate
}

function glyphOf (status: BadgeStatus): Glyph | null {
  if (status.endsWith('-durable')) return 'lock'
  if (status === 'stripped') return 'recover'
  if (status === 'stripped-unrecovered') return 'question'
  if (status === 'unavailable') return 'alert'
  return null
}

/** The durable variant of a verdict, when there is one. */
export function withDurable<T extends string> (status: T, durable: boolean): T | `${T}-durable` {
  const has = status === 'success' || status === 'ai-success' || status === 'warning' || status === 'error'
  return durable && has ? `${status}-durable` : status
}

export function isBadgeStatus (status: string): status is BadgeStatus {
  return status in FILL
}

function strokeGlyph (glyph: Glyph, x: number, y: number, scale: number, width: number): string {
  return `<g data-glyph="${glyph}" transform="translate(${x} ${y}) scale(${scale})" fill="none" stroke="#000000" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round">${GLYPHS[glyph]}</g>`
}

/** The badge as SVG markup. `small` drops the CR letters. */
export function badgeSvg (status: BadgeStatus, opts: { small?: boolean } = {}): string {
  const small = opts.small === true
  const none = status === 'no-credentials'
  const glyph = glyphOf(status)
  const parts = [
    `<path data-part="pin" fill="${FILL[status]}" stroke="${none ? COLOURS.slash : '#000000'}" stroke-width="${none ? 2.2 : 1.6}" d="${PIN}"/>`
  ]
  if (!small) parts.push(`<path data-part="cr" fill="#000000" d="${CR}"/>`)
  if (none) parts.push(`<path data-part="slash" fill="none" stroke="${COLOURS.slash}" stroke-width="3" stroke-linecap="round" d="M6 6L31 31"/>`)
  if (glyph != null) {
    parts.push(small
      ? `<g data-part="indicator">${strokeGlyph(glyph, 9, 9, 0.75, 2.8)}</g>`
      : `<g data-part="indicator"><circle cx="31" cy="10" r="8.6" fill="#FFFFFF" stroke="#000000" stroke-width="1.4"/>${strokeGlyph(glyph, 25, 4, 0.5, 2.8)}</g>`)
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 41 41">${parts.join('')}</svg>`
}

export function badgeDataUrl (status: BadgeStatus, opts: { small?: boolean } = {}): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(badgeSvg(status, opts))}`
}

const LOCK = ' The lock means a public copy of the label exists, so it can be found again if someone removes it from the file.'

const EXPLAIN: Record<BadgeStatus, { title: string, text: string }> = {
  success: { title: 'Checked and trusted', text: 'A known, trusted source signed this file, and it has not changed since.' },
  'success-durable': { title: 'Checked, trusted, and backed up', text: 'A known, trusted source signed this file, and it has not changed since.' + LOCK },
  'ai-success': { title: 'Made with AI, honestly labelled', text: 'A trusted source signed this file and says it was made with AI. It has not changed since.' },
  'ai-success-durable': { title: 'Made with AI, labelled and backed up', text: 'A trusted source signed this file and says it was made with AI.' + LOCK },
  warning: { title: 'Signed, but by someone we do not know', text: 'The file has not changed since it was signed, but the signer is not on a trusted list. Judge the source yourself.' },
  'warning-durable': { title: 'Unknown signer, label backed up', text: 'The file has not changed since it was signed, but the signer is not on a trusted list.' + LOCK },
  error: { title: 'Changed after signing', text: 'This file is not the same as when it was signed. Do not rely on what its label says.' },
  'error-durable': { title: 'Changed after signing, original on record', text: 'This file is not the same as when it was signed.' + LOCK },
  'ai-error': { title: 'Changed after signing', text: 'This file was labelled as made with AI, but it has changed since it was signed. Do not rely on its label.' },
  stripped: { title: 'Label removed, copy found', text: 'The label is gone from this file, but a public copy matches the picture. Treat it as a strong hint, not proof: this copy may have been changed.' },
  'stripped-unrecovered': { title: 'Label removed, no copy found', text: 'This file once carried a label, but it was removed and we could not find a copy.' },
  'no-credentials': { title: 'No label', text: 'This file carries no Content Credentials. That does not mean it is fake: most files have none.' },
  unavailable: { title: 'We could not check', text: 'Something went wrong on our side, so we could not check this file. This says nothing about the file itself.' }
}

/** Plain words for a badge: a short title and one or two sentences. */
export function explainBadge (status: BadgeStatus): { title: string, text: string } {
  return EXPLAIN[status]
}

/** The badges shown in the legend, in reading order. */
export const BADGE_LEGEND: ReadonlyArray<{ status: BadgeStatus }> = [
  { status: 'success' },
  { status: 'success-durable' },
  { status: 'ai-success' },
  { status: 'warning' },
  { status: 'error' },
  { status: 'stripped' },
  { status: 'stripped-unrecovered' },
  { status: 'no-credentials' },
  { status: 'unavailable' }
]
