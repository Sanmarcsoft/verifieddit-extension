/* Renders the Aperture state matrix to SVG files + a contact sheet for review. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderMark, STATE_TABLE } from './aperture'

const OUT = join(import.meta.dir, 'svg')
mkdirSync(OUT, { recursive: true })

const cards: string[] = []
for (const [key, spec] of Object.entries(STATE_TABLE)) {
  const svg = renderMark({ ...spec, motion: false })
  writeFileSync(join(OUT, `${key}.svg`), svg)
  const enc = (s: string): string => `data:image/svg+xml;utf8,${encodeURIComponent(s)}`
  cards.push(`
  <div class="card">
    <div class="sizes">
      <div class="s"><img src="${enc(svg)}" width="16"><em>16</em></div>
      <div class="s"><img src="${enc(svg)}" width="24"><em>24</em></div>
      <div class="s"><img src="${enc(svg)}" width="40"><em>40</em></div>
      <div class="s gray"><img src="${enc(svg)}" width="24"><em>grey</em></div>
      <div class="s onphoto"><img src="${enc(svg)}" width="24"><em>photo</em></div>
    </div>
    <h3>${spec.label}</h3>
    <code>${key}</code>
    <p>${spec.note}</p>
  </div>`)
}

const html = `<!doctype html><meta charset="utf-8"><style>
  *{box-sizing:border-box}
  body{margin:0;padding:32px;background:#F6F7F9;font:14px/1.5 ui-sans-serif,-apple-system,Segoe UI,Roboto,sans-serif;color:#12161C}
  h1{font-size:20px;margin:0 0 4px}
  .sub{color:#5A6473;margin:0 0 24px;max-width:70ch}
  .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
  .card{background:#fff;border:1px solid #E3E7EC;border-radius:12px;padding:16px}
  .sizes{display:flex;align-items:flex-end;gap:14px;padding:12px;background:#FAFBFC;border-radius:8px;margin-bottom:12px}
  .s{display:flex;flex-direction:column;align-items:center;gap:5px}
  .s em{font-style:normal;font-size:9px;color:#96A0AE}
  .gray img{filter:grayscale(1) contrast(1.05)}
  .onphoto{padding:4px;border-radius:6px;background:linear-gradient(125deg,#2b3d4f,#7d6a54 45%,#c8a97e)}
  .onphoto em{color:#fff}
  h3{font-size:13px;margin:0 0 2px}
  code{font-size:11px;color:#0F766E;background:#F0FAF9;padding:1px 5px;border-radius:4px}
  p{font-size:11.5px;line-height:1.5;color:#5A6473;margin:8px 0 0}
</style>
<h1>Aperture – Verifieddit provenance mark</h1>
<p class="sub">Four orthogonal channels: ring continuity = integrity, lit segments = durability pillars,
core glyph = origin, apex seal = signer identity. Every state is silhouette-distinct in greyscale at 16px.</p>
<div class="grid">${cards.join('')}</div>`

writeFileSync(join(import.meta.dir, 'contact-sheet.html'), html)
console.log(`wrote ${Object.keys(STATE_TABLE).length} svgs -> ${OUT}`)
