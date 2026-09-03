/*
 *  APERTURE – a parametric provenance mark for Verifieddit.
 *
 *  Replaces 10 hand-drawn, hue-differentiated SVG strings (src/icon.ts) with one
 *  generator over four ORTHOGONAL channels. The current set encodes everything in
 *  hue (green / amber / red) plus meaningless corner squares; that fails WCAG 1.4.1
 *  (colour as sole carrier), collapses on the red/green deuteranopia axis, and has
 *  no room left to express durability at all.
 *
 *  Research grounding (see the accompanying report):
 *   - Chrome padlock post-mortem: 89% of users misread a trust glyph. Never draw a
 *     verdict; draw a SHAPE that points at more detail. Reserve saturated colour
 *     for the exception, keep the default state quiet and ink-coloured. Critically:
 *     "verified" is NOT green – green reads as "safe", which is precisely the
 *     misconception that killed the padlock.
 *   - Material Symbols / SF Symbols 7: state belongs on a variable AXIS, not in a
 *     separate glyph. The durability pillars are a variable-draw arc.
 *   - EU Code of Practice on marking AI-generated content (binding 2026-08-02):
 *     the AI origin state uses the standardised "AI" acronym wordmark, monochrome.
 *
 *  THE FOUR CHANNELS
 *   1. integrity  -> ring CONTINUITY   (intact / fault / dotted / none)
 *   2. pillars    -> ring ARC LENGTH   (0..3 lit segments; DurablePillars.count)
 *   3. origin     -> CORE glyph        (aperture iris / "AI" / split / media)
 *   4. identity   -> SEAL at ring apex (filled / hollow / struck / none)
 *
 *  Every state is silhouette-distinct: desaturate to greyscale and each one still
 *  reads. Colour is redundant reinforcement only.
 */

export type Integrity = 'intact' | 'broken' | 'absent' | 'unchecked'
export type Origin = 'capture' | 'ai' | 'ai-partial' | 'unknown'
export type Identity = 'trusted' | 'unknown' | 'expired' | 'none'
export type Media = 'image' | 'video' | 'audio'

export interface MarkSpec {
  integrity: Integrity
  /** DurablePillars.count – P1 signed+timestamped, P2 watermark, P3 store-recoverable. */
  pillars?: 0 | 1 | 2 | 3
  origin?: Origin
  identity?: Identity
  /** Only rendered as the core when origin is 'unknown' – once provenance is known,
   *  the media type is self-evident from the element the badge sits on. */
  media?: Media
  /** Paper plate behind the mark so it survives on arbitrary photography. */
  plate?: boolean
  /** Emit CSS for the scan sweep / draw-on, gated on prefers-reduced-motion. */
  motion?: boolean
}

const INK = '#12161C'
const PAPER = '#FFFFFF'
const SLATE = '#8A94A6'
const AMBER = '#B45309'
const RED = '#B42318'
const TEAL = '#0F766E' // full durability – a quiet reward, never a "safe" green

const C = 12 // centre
const R = 8.9 // ring radius
const WR = 1.75 // ring stroke

// Ring is 3 segments = the 3 durability pillars, with a wider gap at the apex
// reserved for the identity seal.
const APEX_GAP = 34
const SEG_GAP = 9
const SEG = (360 - APEX_GAP - 2 * SEG_GAP) / 3 // 102.67

interface Seg { a0: number, a1: number }
const SEGMENTS: Seg[] = [
  { a0: APEX_GAP / 2, a1: APEX_GAP / 2 + SEG },
  { a0: APEX_GAP / 2 + SEG + SEG_GAP, a1: APEX_GAP / 2 + 2 * SEG + SEG_GAP },
  { a0: APEX_GAP / 2 + 2 * SEG + 2 * SEG_GAP, a1: 360 - APEX_GAP / 2 }
]

/** Polar -> cartesian, 0deg = 12 o'clock, clockwise. */
function pt (deg: number, r = R): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180
  return [C + r * Math.cos(a), C + r * Math.sin(a)]
}

function arc (a0: number, a1: number, r = R): string {
  const [x0, y0] = pt(a0, r)
  const [x1, y1] = pt(a1, r)
  const large = a1 - a0 > 180 ? 1 : 0
  return `M${f(x0)} ${f(y0)}A${f(r)} ${f(r)} 0 ${large} 1 ${f(x1)} ${f(y1)}`
}

const f = (n: number): string => (Math.round(n * 100) / 100).toString()

/* ---------------------------------------------------------------- channel 1+2 */

function ring (s: MarkSpec): string {
  const pillars = s.pillars ?? 0
  const parts: string[] = []

  if (s.integrity === 'unchecked') {
    // No verdict yet. A single sweeping arc – honest "working", not a fake camera.
    return `<path class="ap-sweep" d="${arc(20, 100)}" fill="none" stroke="${SLATE}" stroke-width="${WR}" stroke-linecap="round"/>`
  }

  if (s.integrity === 'absent') {
    // Checked, nothing found. Dotted texture is unmistakable at 16px and reads as
    // "the ring that should be here isn't".
    return `<circle cx="${C}" cy="${C}" r="${R}" fill="none" stroke="${SLATE}" stroke-width="${WR}" stroke-linecap="round" stroke-dasharray="0.01 3.6" opacity="0.85"/>`
  }

  if (s.integrity === 'broken') {
    // FAULT. One segment removed entirely and the surviving lower arc displaced
    // radially outward with squared caps – a geological fault line. No other state
    // has an asymmetric radius, so this is unique in silhouette even at 16px.
    parts.push(`<path d="${arc(SEGMENTS[0].a0, SEGMENTS[0].a1)}" fill="none" stroke="${RED}" stroke-width="${WR}" stroke-linecap="butt"/>`)
    parts.push(`<path d="${arc(SEGMENTS[2].a0 + 6, SEGMENTS[2].a1, R + 2.1)}" fill="none" stroke="${RED}" stroke-width="${WR}" stroke-linecap="butt"/>`)
    return parts.join('')
  }

  // intact – light `pillars` of 3 segments. Unlit segments stay as ghosts so the
  // enclosure silhouette survives (this is what lets Magic-Replace-style morphs
  // between states feel continuous: the enclosure never moves).
  const litColour = s.identity === 'unknown' || s.identity === 'expired'
    ? AMBER
    : pillars === 3 ? TEAL : INK

  SEGMENTS.forEach((seg, i) => {
    const lit = i < pillars
    parts.push(
      `<path class="${lit ? 'ap-lit' : 'ap-ghost'}" d="${arc(seg.a0, seg.a1)}" fill="none" ` +
      `stroke="${lit ? litColour : SLATE}" stroke-width="${WR}" stroke-linecap="round"` +
      `${lit ? '' : ' opacity="0.28"'}/>`
    )
  })
  return parts.join('')
}

/* ------------------------------------------------------------------ channel 4 */

function seal (s: MarkSpec): string {
  const id = s.identity ?? 'none'
  if (id === 'none' || s.integrity === 'unchecked' || s.integrity === 'absent') return ''
  const [x, y] = pt(0)
  const r = 2.45
  const colour = id === 'trusted' ? (s.integrity === 'broken' ? RED : INK) : AMBER

  // v2: identity was carried by fill + hue alone. On the contact sheet the hollow
  // ring collapsed to a dot below ~24px, leaving amber-vs-ink as the only cue –
  // exactly the colour dependence this system exists to remove. Identity now has
  // its own SHAPE channel: disc / annulus / diamond, three distinct silhouettes.
  if (id === 'trusted') {
    // Solid disc = a named signer resolved against a trust list. Solid vs hollow is
    // a fill-axis distinction (Material FILL), animatable as a CSS transition.
    return `<circle cx="${f(x)}" cy="${f(y)}" r="${f(r)}" fill="${colour}"/>`
  }
  if (id === 'unknown') {
    // Annulus with a knocked-out core – the hole is punched, not stroked, so it
    // survives rasterisation at 16px where a 0.5px stroke gap would not.
    return `<circle cx="${f(x)}" cy="${f(y)}" r="${f(r + 0.25)}" fill="${colour}"/>` +
      `<circle cx="${f(x)}" cy="${f(y)}" r="${f(r - 1.05)}" fill="${PAPER}"/>`
  }
  // expired / revoked – a diamond. Different silhouette, not a different colour.
  const d = r + 0.5
  return `<path d="M${f(x)} ${f(y - d)}L${f(x + d)} ${f(y)}L${f(x)} ${f(y + d)}L${f(x - d)} ${f(y)}Z" fill="${colour}"/>` +
    `<path d="M${f(x - 1.35)} ${f(y)}L${f(x + 1.35)} ${f(y)}" stroke="${PAPER}" stroke-width="1.05" stroke-linecap="round"/>`
}

/* ------------------------------------------------------------------ channel 3 */

/** Camera-diaphragm iris. Says "a lens made this" without the literal-camera
 *  cliche, and it is the one origin glyph that cannot be misread as a verdict tick.
 *
 *  v2: the first cut used six full 120-deg chords, which cross deep through the
 *  centre and render as a gear/asterisk at 16px (confirmed on the contact sheet).
 *  Rebuilt as a closed hexagon with six tangential blade tails – the actual
 *  construction of a diaphragm – which keeps an open centre and reads as an iris.
 */
function aperture (colour: string, scale = 1, sw = 1.35): string {
  const rh = 3.3 * scale // hexagon (the open aperture)
  const rt = 5.15 * scale // blade tail reach
  const hex: string[] = []
  const tails: string[] = []
  for (let i = 0; i < 6; i++) {
    const [x, y] = pt(i * 60, rh)
    hex.push(`${i === 0 ? 'M' : 'L'}${f(x)} ${f(y)}`)
    // Each blade sweeps off its vertex, trailing behind – the twist that makes a
    // diaphragm read as a diaphragm rather than a plain hexagon. Held to 26deg:
    // at 40deg the six tails read as a pinwheel and the mark starts to look like
    // a "refresh/processing" spinner, which is the wrong meaning entirely.
    const [tx, ty] = pt(i * 60 - 26, rt)
    tails.push(`M${f(x)} ${f(y)}L${f(tx)} ${f(ty)}`)
  }
  hex.push('Z')
  return `<path d="${hex.join('')}${tails.join('')}" fill="none" stroke="${colour}" ` +
    `stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>`
}

/** EU standardised AI wordmark (Code of Practice, Annex 1 – monochrome only). */
function aiMark (colour: string, sw = 1.85): string {
  const top = 8.5
  const bot = 15.5
  // "A"
  const aL = 7.55; const aR = 12.75; const aApex = (aL + aR) / 2
  const barY = 13.0
  const barL = aL + (aApex - aL) * 0.42
  const barR = aR - (aR - aApex) * 0.42
  // "I"
  const iX = 15.35
  return (
    `<path d="M${f(aL)} ${f(bot)}L${f(aApex)} ${f(top)}L${f(aR)} ${f(bot)}M${f(barL)} ${f(barY)}L${f(barR)} ${f(barY)}" ` +
    `fill="none" stroke="${colour}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<path d="M${f(iX)} ${f(top)}L${f(iX)} ${f(bot)}" fill="none" stroke="${colour}" stroke-width="${sw}" stroke-linecap="round"/>`
  )
}

function mediaGlyph (m: Media, colour: string): string {
  if (m === 'video') {
    return `<path d="M9.6 7.9 17 12l-7.4 4.1z" fill="none" stroke="${colour}" stroke-width="1.5" stroke-linejoin="round"/>`
  }
  if (m === 'audio') {
    const bars = [[8.4, 3.0], [10.4, 5.4], [12.4, 6.8], [14.4, 4.4], [16.4, 2.2]]
    return bars
      .map(([x, h]) => `<path d="M${f(x)} ${f(12 - h)}L${f(x)} ${f(12 + h)}" stroke="${colour}" stroke-width="1.45" stroke-linecap="round"/>`)
      .join('')
  }
  return `<path d="M7.4 15.6 10.6 11.8l2.3 2.7 2-2.2 2.7 3.3z" fill="none" stroke="${colour}" stroke-width="1.4" stroke-linejoin="round"/>` +
    `<circle cx="9.5" cy="9.4" r="1.3" fill="none" stroke="${colour}" stroke-width="1.4"/>`
}

function core (s: MarkSpec, id: string): string {
  const dim = s.integrity === 'absent' || s.integrity === 'unchecked'
  const colour = dim ? SLATE : s.integrity === 'broken' ? RED : INK
  const op = dim ? ' opacity="0.75"' : ''
  const origin = s.origin ?? 'unknown'

  if (origin === 'ai') return `<g${op}>${aiMark(colour)}</g>`
  if (origin === 'capture') return `<g${op}>${aperture(colour)}</g>`

  if (origin === 'ai-partial') {
    // EU set has a distinct "Partially AI-Modified" variant.
    //
    // v2: the first cut split the core diagonally – half iris, half "AI". On the
    // contact sheet that rendered as an unreadable smear at every size, because
    // half a wordmark is not a wordmark. Rebuilt as compounding rather than
    // splitting: the lens ORIGIN survives intact (the asset really was captured),
    // with a machine-touch chip compounded onto it. Semantically truer too –
    // "pre-existing human content altered with AI" is additive, not a bisection.
    return (
      `<g${op}>` +
      `<g transform="translate(-2.4,-2.4) scale(0.84) translate(2.9,2.9)">${aperture(colour, 1, 1.5)}</g>` +
      `<circle cx="16.9" cy="16.9" r="6.15" fill="${PAPER}"/>` +
      `<circle cx="16.9" cy="16.9" r="5.15" fill="${colour}"/>` +
      `<g transform="translate(16.9,16.9) scale(0.5) translate(-11.95,-12)">${aiMark(PAPER, 2.9)}</g>` +
      `</g>`
    )
  }

  return `<g${op}>${mediaGlyph(s.media ?? 'image', colour)}</g>`
}

/* ---------------------------------------------------------------------- shell */

const MOTION_CSS =
  `.ap-sweep{transform-origin:12px 12px;animation:apspin 1.15s linear infinite}` +
  `@keyframes apspin{to{transform:rotate(360deg)}}` +
  `.ap-lit{stroke-dasharray:64;animation:apdraw .42s cubic-bezier(.2,.8,.3,1) both}` +
  `@keyframes apdraw{from{stroke-dashoffset:64}to{stroke-dashoffset:0}}` +
  `@media(prefers-reduced-motion:reduce){` +
  `.ap-sweep{animation:none;opacity:.55}.ap-lit{animation:none;stroke-dasharray:none}}`

let uid = 0

export function renderMark (s: MarkSpec): string {
  const id = (uid++).toString(36)
  const plate = s.plate !== false
    ? `<circle cx="12" cy="12" r="11.4" fill="${PAPER}" opacity="0.94"/>` +
      `<circle cx="12" cy="12" r="11.4" fill="none" stroke="${INK}" stroke-width="0.6" opacity="0.14"/>`
    : ''
  const style = s.motion === true ? `<style>${MOTION_CSS}</style>` : ''
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" role="img">` +
    style + plate + core(s, id) + ring(s) + seal(s) +
    `</svg>`
  )
}

/* ------------------------------------------------- the extension's state table */

/** Maps the extension's existing VALIDATION_STATUS (plus the durability data it
 *  already computes in durableCredentials.ts but currently throws away at L1). */
export const STATE_TABLE: Record<string, MarkSpec & { label: string, note: string }> = {
  scanning: {
    label: 'Scanning',
    note: 'Replaces the static camera/video/audio placeholders. An honest indeterminate sweep.',
    integrity: 'unchecked', origin: 'unknown', media: 'image', identity: 'none', motion: true
  },
  'scanning-video': {
    label: 'Scanning (video)',
    note: 'Media type only shows while origin is still unknown.',
    integrity: 'unchecked', origin: 'unknown', media: 'video', identity: 'none', motion: true
  },
  'scanning-audio': {
    label: 'Scanning (audio)',
    note: 'Audio has no visible frame, so the waveform core carries the affordance.',
    integrity: 'unchecked', origin: 'unknown', media: 'audio', identity: 'none', motion: true
  },
  'no-credentials': {
    label: 'No credentials',
    note: 'Checked, nothing found. Dotted ring = the enclosure that should be here is missing. Deliberately quiet: as C2PA adoption rises this becomes the common case, and a loud warning here would repeat the padlock mistake in reverse.',
    integrity: 'absent', origin: 'unknown', media: 'image', identity: 'none'
  },
  'embed-only': {
    label: 'Signed, embed-only (P1)',
    note: 'NEW STATE. One lit segment. Signature survives only while the metadata does – strip EXIF and it is gone. Today this is indistinguishable from a fully durable asset.',
    integrity: 'intact', pillars: 1, origin: 'capture', identity: 'trusted'
  },
  durable: {
    label: 'Durable (P1+P2)',
    note: 'NEW STATE. Two segments: signed, timestamped, and carrying a TrustMark soft binding. Survives re-encode.',
    integrity: 'intact', pillars: 2, origin: 'capture', identity: 'trusted'
  },
  recoverable: {
    label: 'Durable + recoverable (P1+P2+P3)',
    note: 'Full ring in teal. byBinding probe confirmed the credential is recoverable from the manifest store. The strongest claim the system can make – and the first time L1 has been able to say it.',
    integrity: 'intact', pillars: 3, origin: 'capture', identity: 'trusted'
  },
  'untrusted-signer': {
    label: 'Signer not on trust list',
    note: 'Replaces the amber "warning". The ring is INTACT (content is unaltered) – only the seal is hollow. Separating integrity from identity is the single biggest legibility win: today both collapse into one amber blob.',
    integrity: 'intact', pillars: 2, origin: 'capture', identity: 'unknown'
  },
  expired: {
    label: 'Certificate expired',
    note: 'Struck seal. Distinct from untrusted – the signer was known, the credential aged out.',
    integrity: 'intact', pillars: 2, origin: 'capture', identity: 'expired'
  },
  tampered: {
    label: 'Integrity failure',
    note: 'The fault. Ring severed and displaced. This is the only state that earns full red, and its silhouette is unique even in greyscale at 16px.',
    integrity: 'broken', pillars: 0, origin: 'capture', identity: 'trusted'
  },
  'ai-verified': {
    label: 'AI-generated, signed',
    note: 'EU Code of Practice "AI" wordmark, monochrome. Legally binding for in-scope deployers from 2026-08-02 – the current 10x10 black square communicates nothing and is not defensible against Article 50.',
    integrity: 'intact', pillars: 2, origin: 'ai', identity: 'trusted'
  },
  'ai-recoverable': {
    label: 'AI-generated, fully durable',
    note: 'The state SanMarcSoft agent media should produce: trainedAlgorithmicMedia + all three pillars.',
    integrity: 'intact', pillars: 3, origin: 'ai', identity: 'trusted'
  },
  'ai-tampered': {
    label: 'AI-generated, integrity failure',
    note: 'Fault ring plus AI core. Two channels, read independently.',
    integrity: 'broken', pillars: 0, origin: 'ai', identity: 'trusted'
  },
  'ai-partial': {
    label: 'Partially AI-modified',
    note: 'NEW STATE. EU set has this as a first-class variant and the extension has no equivalent. Diagonal seam: lens above, machine below.',
    integrity: 'intact', pillars: 2, origin: 'ai-partial', identity: 'trusted'
  }
}
