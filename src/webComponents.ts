/*
 *  Copyright (c) Microsoft Corporation.
 *  Licensed under the MIT license.
 */

import { LitElement, html, css, type TemplateResult, type PropertyValues, nothing } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { type ExtensionC2paIngredient, type C2paResult } from './c2pa'
import { type CertificateInfoExtended } from './certs/certs'
import { type DurablePillars } from './durableCredentials'
import { MSG_L3_INSPECT_URL, TRUSTEDDIT_LINK, taggedLink, MSG_SET_MANIFEST_STORE_PROBE, MANIFEST_STORE_PROBE_KEY, MANIFEST_STORE_PROBE_DEFAULT } from './constants'
import './provenanceDiagram'

/*
  The C2pa library does not export all its types, we extract them from
  the types that are exported
*/
type Activity = Exclude<C2paResult['editsAndActivity'], null>[number]

interface IconTextItem {
  icon: string | null
  text: string[]
}

type StatusTone = 'verified' | 'authentic' | 'invalid' | 'unsigned'

// A C2PA validation_status code is a real INTEGRITY failure (→ "invalid"/red)
// unless it is merely a trust/expiry signal. signingCredential.untrusted just
// means the signer is not in the trust list (shown separately as the trust
// state); signingCredential.expired / timeStamp.untrusted are expiry/trust, not
// tampering. Treating those as "invalid" wrongly implies the content was
// altered. Everything else in the list (hash/signature mismatch, missing
// assertions, malformed claims, …) is a genuine failure.
const NON_FATAL_VALIDATION_CODE = /\.(untrusted|expired)$/i
function isFatalValidationCode (code: string): boolean {
  return code !== '' && !NON_FATAL_VALIDATION_CODE.test(code)
}

/*
 * Dark "frosted glass" theme tokens shared across every custom element in this
 * module. The verifier panel is rebuilt to match the trusteddit.com
 * verification aesthetic: a translucent slate pane, monospace type, an
 * emerald/cyan accent palette and a staged + typewriter reveal.
 */
const sharedStyles = css`
    :host {
        /* #129: alpha lifted to 0.97 so text stays legible over busy host
         * pages (backdrop-filter cannot blur across the iframe boundary). */
        --glass-bg: rgba(15, 23, 42, 0.97);
        --glass-bg-soft: rgba(30, 41, 59, 0.6);
        --border-color: rgba(148, 163, 184, 0.18);
        --border-strong: rgba(148, 163, 184, 0.28);
        --text: #cbd5e1;
        --text-bright: #e2e8f0;
        /* #129: slate-400 (~4.6:1 on the glass) instead of slate-500, for AA. */
        --text-dim: #94a3b8;
        --accent: #7dd3fc;        /* sky-300 */
        --accent-bright: #38bdf8; /* sky-400 */
        --ok: #86efac;            /* emerald-300 */
        --ok-glow: rgba(52, 211, 153, 0.5);
        --bad: #fda4af;           /* rose-300 */
        --warn: #fcd34d;          /* amber-300 */
        --radius: 14px;
        --font-family: 'JetBrains Mono', 'IBM Plex Mono', ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
        --font-size: 12px;
        --font-bold: 600;
    }
    /* #129: honour reduced-motion across every component using this stylesheet,
     * not just the headline reveal — kills collapsible/pillar transitions too. */
    @media (prefers-reduced-motion: reduce) {
        * { animation: none !important; transition: none !important; }
    }`

/* The c2pa-overlay host is transparent; the #card inside is the glass pane.
 * Padding leaves room for the card's drop-shadow inside the iframe. */
const overlayHostStyles = css`
    :host {
        display: block;
        background: transparent;
        padding: 12px;
        box-sizing: border-box;
        min-height: 168px;
    }`

const innerHostStyles = css`
    :host {
        display: block;
    }`

@customElement('c2pa-overlay')
export class C2paOverlay extends LitElement {
  static styles = [
    sharedStyles,
    overlayHostStyles,
    css`
      * {
          font-family: var(--font-family);
          font-size: var(--font-size);
          box-sizing: border-box;
      }

      /* ── The frosted-glass card ─────────────────────────────────── */
      #card {
          position: relative;
          color: var(--text);
          background: var(--glass-bg);
          border: 1px solid var(--border-color);
          border-radius: var(--radius);
          box-shadow:
              0 20px 48px -16px rgba(2, 6, 23, 0.75),
              0 0 0 1px rgba(15, 23, 42, 0.6),
              inset 0 1px 0 rgba(148, 163, 184, 0.08);
          backdrop-filter: blur(16px) saturate(140%);
          -webkit-backdrop-filter: blur(16px) saturate(140%);
          padding: 16px 16px 14px;
          overflow: hidden;
      }

      /* Soft cyan/emerald sheen so the pane reads as glass even over an
       * opaque host element where backdrop-filter has nothing to blur. */
      #card::before {
          content: '';
          position: absolute;
          inset: 0;
          pointer-events: none;
          background:
              radial-gradient(120% 80% at 0% 0%, rgba(56, 189, 248, 0.10), transparent 55%),
              radial-gradient(120% 90% at 100% 0%, rgba(52, 211, 153, 0.08), transparent 55%);
      }

      #card > * { position: relative; }

      /* ── Header ─────────────────────────────────────────────────── */
      .header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding-bottom: 10px;
          border-bottom: 1px solid var(--border-color);
      }

      .header-left {
          display: flex;
          align-items: center;
          gap: 8px;
          min-width: 0;
      }

      .brand {
          letter-spacing: 0.14em;
          text-transform: uppercase;
          font-size: 10px;
          font-weight: var(--font-bold);
          color: var(--text-dim);
          white-space: nowrap;
      }

      .status-badge {
          flex: none;
          border-radius: 4px;
          padding: 3px 8px;
          font-size: 10px;
          font-weight: var(--font-bold);
          letter-spacing: 0.1em;
          text-transform: uppercase;
      }
      .status-badge.verified  { background: rgba(16, 185, 129, 0.14); color: var(--ok); }
      .status-badge.authentic { background: rgba(56, 189, 248, 0.14); color: var(--accent); }
      .status-badge.invalid   { background: rgba(244, 63, 94, 0.14);  color: var(--bad); }
      .status-badge.unsigned  { background: rgba(245, 158, 11, 0.14); color: var(--warn); }

      /* ── Title row (thumbnail + media) ──────────────────────────── */
      .title {
          display: grid;
          grid-template-columns: 44px 1fr;
          gap: 10px;
          align-items: center;
          margin-top: 12px;
      }
      .thumbnailFrame {
          width: 44px;
          height: 44px;
          display: flex;
          justify-content: center;
          align-items: center;
          overflow: hidden;
          border-radius: 8px;
          border: 1px solid var(--border-color);
          background: var(--glass-bg-soft);
      }
      .thumbnail { max-width: 100%; max-height: 100%; object-fit: cover; }
      .media-line { color: var(--text-bright); font-weight: var(--font-bold); }
      .media-sub { color: var(--text-dim); font-size: 11px; margin-top: 2px; }

      /* ── Monospace verification log ─────────────────────────────── */
      .log {
          margin-top: 12px;
          display: grid;
          grid-template-columns: auto 1fr;
          gap: 4px 12px;
          font-size: 11px;
          line-height: 1.5;
      }
      .log .k { color: var(--text-dim); white-space: nowrap; }
      .log .k::before { content: '▸ '; color: var(--accent); }
      .log .v { color: var(--text); word-break: break-word; }
      .log .v.ok  { color: var(--ok); }
      .log .v.bad { color: var(--bad); }
      .log .v.dim { color: var(--text-dim); }

      /* ── Validation errors ──────────────────────────────────────── */
      .errors {
          margin-top: 12px;
          border: 1px solid rgba(244, 63, 94, 0.3);
          background: rgba(244, 63, 94, 0.08);
          border-radius: 8px;
          padding: 10px 12px;
      }
      .errors .eh { color: var(--bad); font-weight: var(--font-bold); font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; }
      .errors ul { margin: 6px 0 0; padding-left: 18px; }
      .errors li { color: #fecdd3; font-size: 11px; margin-bottom: 2px; }

      /* ── Footer (inspect link) ──────────────────────────────────── */
      /* Secondary action: present and findable, never competing with the
       * verdict above it. */
      .sign-cta {
          margin-left: auto;
          text-decoration: none;
          opacity: 0.85;
      }
      .sign-cta:hover { opacity: 1; text-decoration: underline; }

      .footer {
          margin-top: 14px;
          padding-top: 12px;
          border-top: 1px solid var(--border-color);
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 8px;
          font-size: 11px;
          color: var(--text-dim);
      }
      .link {
          color: var(--accent);
          text-decoration: none;
          cursor: pointer;
          border-bottom: 1px dotted rgba(125, 211, 252, 0.5);
      }
      .link:hover { color: var(--accent-bright); }

      .more {
          display: inline-block;
          padding: 4px 10px;
          font-size: 11px;
          color: var(--text);
          background: transparent;
          border: 1px solid var(--border-strong);
          border-radius: 6px;
          cursor: pointer;
      }
      .more:hover { background: var(--glass-bg-soft); }

      /* The graph is the headline capability, so it gets room in the panel
         proper rather than the cramped treatment a collapsible section gets. */
      .provenance-feature {
          display: block;
          margin-top: 10px;
      }
      .provenance-feature-label {
          font-size: 11px;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: var(--text-dim, #94a3b8);
          margin-bottom: 6px;
      }
      .provenance-feature c2pa-provenance-graph {
          display: block;
          width: 100%;
      }

      .additional-info {
          overflow: hidden;
          max-height: 0;
          transition: max-height 0.3s ease-in-out;
          display: flex;
          flex-direction: column;
          gap: 4px;
          margin-top: 8px;
      }

      .bold { font-weight: var(--font-bold); color: var(--text-bright); }

      /* #128/#129: screen-reader-only verdict summary (present in DOM + textContent). */
      .sr-summary {
        position: absolute;
        width: 1px; height: 1px;
        padding: 0; margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
      }
      .vglyph { font-weight: 700; }

      /* ── Staged reveal animation ────────────────────────────────── */
      .reveal {
          opacity: 0;
          animation: revealIn 0.36s ease forwards;
      }
      @keyframes revealIn {
          from { opacity: 0; transform: translateY(6px); }
          to   { opacity: 1; transform: none; }
      }
      @media (prefers-reduced-motion: reduce) {
          .reveal { opacity: 1; animation: none; transform: none; }
          #card { backdrop-filter: none; -webkit-backdrop-filter: none; }
      }
  `]

  private _c2paResult: C2paResult | undefined

  private thumbprintUrl?: string

  private signer?: string

  private trustList?: string

  private status?: { errors: boolean, trusted: boolean, tone: StatusTone, expired: boolean }

  @property({ type: Boolean })
    additionalInfoCollapsed = true

  toggleAdditionalInfo = (): void => {
    this.additionalInfoCollapsed = !this.additionalInfoCollapsed

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const additionalInfoEl = this.shadowRoot!.querySelector('.additional-info')!
    const div: HTMLDivElement = additionalInfoEl as HTMLDivElement
    if (this.additionalInfoCollapsed) {
      C2paCollapsible.close()
      // Clip again BEFORE animating shut, or the content spills during collapse.
      div.style.overflow = 'hidden'
      div.style.maxHeight = div.scrollHeight + 'px'
      void div.offsetHeight
      div.style.maxHeight = '0'
    } else {
      div.style.maxHeight = 'none'
      const height = div.scrollHeight + 'px'
      div.style.maxHeight = '0'
      void div.offsetHeight
      div.style.maxHeight = height
      let settled = false
      const settle = (): void => {
        if (settled) return
        settled = true
        div.style.maxHeight = 'none'
        // `overflow: hidden` exists only to clip the slide-open animation. Left
        // in place afterwards it silently clips anything the sections grow into
        // AFTER this height was measured — and the height is measured while
        // every collapsible is still shut. Opening "Provenance chain" then adds
        // ~400px of diagram whose bottom edge, including the zoom/Fit/Full
        // screen control row, lands outside the box: laid out, invisible, and
        // not hit-testable, so clicking Full screen did nothing at all
        // (elementFromPoint at the button returned the overlay host, #141).
        // Once the animation is done there is nothing left to clip.
        div.style.overflow = 'visible'
        div.removeEventListener('transitionend', settle)
        clearTimeout(timer)
      }
      // The panel must not depend on an animation event to become usable.
      // `sharedStyles` kills every transition under
      // `prefers-reduced-motion: reduce`, so `transitionend` never fires for
      // anyone who has that system setting on — and the panel then stays frozen
      // at the height it had while all sections were shut, with overflow still
      // hidden. Every section still toggled; the revealed content was simply
      // clipped away, so the disclosure arrows read as dead. A background tab,
      // a display with the transition optimised out, or a second click during
      // the animation produce the same silence. The timer is the guarantee and
      // `transitionend` is only the fast path.
      const timer = setTimeout(settle, 400)
      div.addEventListener('transitionend', settle)
    }
  }

  @property({ type: Object })
  get c2paResult (): C2paResult | undefined {
    return this._c2paResult
  }

  set c2paResult (newValue: C2paResult | undefined) {
    if (newValue === this._c2paResult || newValue == null) {
      return
    }
    const oldValue = this._c2paResult
    this._c2paResult = newValue
    this.status = this.setStatus(newValue)
    this.requestUpdate('c2paResult', oldValue)
    this.thumbprintUrl = newValue?.source?.thumbnail.data
    if (this.thumbprintUrl === '' && newValue?.source?.type.startsWith('video/')) {
      this.thumbprintUrl = chrome.runtime.getURL('icons/video.svg')
    }
    if (this.thumbprintUrl === '' && newValue?.source?.type.startsWith('audio/')) {
      this.thumbprintUrl = chrome.runtime.getURL('icons/audio.svg')
    }
    const activeManifest = newValue?.manifestStore?.manifests[newValue.manifestStore.activeManifest]
    this.signer = activeManifest?.signatureInfo.issuer ?? 'unknown entity'
    this.trustList = newValue?.trustList?.tlInfo.name ?? 'unknown'
  }

  private setStatus (c2paResult: C2paResult): { errors: boolean, trusted: boolean, tone: StatusTone, expired: boolean } {
    const codes = c2paResult.manifestStore?.validationStatus ?? []
    // Only genuine integrity failures make a credential "invalid". An untrusted
    // or expired signer is not a failure — it is signed, intact, just not in the
    // trust list (or past its cert validity).
    const errors = codes.some(isFatalValidationCode)
    const expired = codes.some((c) => /\.expired$/i.test(c))
    const trusted = c2paResult.trustList != null
    const signed = (c2paResult.certChain?.length ?? 0) > 0 ||
      (c2paResult.manifestStore?.manifests?.length ?? 0) > 0
    const tone: StatusTone = errors
      ? 'invalid'
      : !signed
          ? 'unsigned'
          : trusted ? 'verified' : 'authentic'
    return { errors, trusted, tone, expired }
  }

  private readonly handleClick = (): void => {
    void chrome.runtime.sendMessage({
      action: MSG_L3_INSPECT_URL,
      data: this.c2paResult?.url
    })
  }

  /* Build the staged + typewritten monospace verification log. */
  private renderLog (c2paResult: C2paResult): TemplateResult {
    const trusted = this.status?.trusted === true
    const errors = this.status?.errors === true
    const manifestMap = c2paResult.manifestStore?.manifests
    const manifestCount = manifestMap === undefined ? 0 : manifestMap.length
    const tstTokens = c2paResult.tstTokens ?? []
    const tsaTrusted = c2paResult.tsaTrustList != null
    const tsLabel = tstTokens.length === 0
      ? 'none'
      : tsaTrusted ? 'RFC 3161 · trusted' : 'RFC 3161'

    // #161: a trust-list match alone is not a green tick when the signing cert
    // has expired and no TRUSTED RFC 3161 timestamp proves the signature was
    // made inside the validity window. The on-page badge already degrades to
    // 'error' for this case (getC2PAStatus); the trust row rendered a plain
    // checkmark regardless, telling the user the signer is fine.
    const expiredNoTs = this.status?.expired === true && !(tstTokens.length > 0 && tsaTrusted)
    const trustLabel = !trusted
      ? 'not in trust list'
      : expiredNoTs
          ? `${this.trustList ?? 'trust list'} · cert expired, no trusted timestamp`
          : (this.trustList ?? 'trust list')

    // [key, value, valueClass, typeSpeed]
    const rows: Array<[string, string, string, number]> = [
      ['signer', this.signer ?? 'unknown', trusted && !expiredNoTs ? 'ok' : '', 12],
      ['trust', trustLabel, trusted && !expiredNoTs ? 'ok' : 'dim', 10],
      ['timestamp', tsLabel, tstTokens.length === 0 ? 'dim' : (tsaTrusted ? 'ok' : ''), 14],
      ['manifests', String(manifestCount), 'dim', 24]
    ]
    if (errors) {
      rows.push(['result', 'validation errors present', 'bad', 14])
    } else if (this.status?.expired === true) {
      // Expired signer cert is an expiry note, not an integrity failure.
      rows.push(['cert', 'signing certificate expired', 'dim', 14])
    }

    return html`
      <div class="log">
        ${rows.map(([k, v, cls, speed], i) => html`
          <div class="k reveal" style="animation-delay:${i * 110}ms">${k}</div>
          <div class="v ${cls} reveal" style="animation-delay:${i * 110}ms">
            ${cls === 'ok' ? html`<span class="vglyph">✓ </span>` : cls === 'bad' ? html`<span class="vglyph">✗ </span>` : nothing}<c2pa-typewriter .text=${v} .speed=${speed} .startDelay=${i * 110 + 60}></c2pa-typewriter>
          </div>
        `)}
      </div>
    `
  }

  private renderErrors (validation: string[]): TemplateResult | typeof nothing {
    // Only show genuine integrity failures here — not untrusted/expired, which
    // are surfaced as the trust state and the expiry note respectively.
    const fatal = validation.filter(isFatalValidationCode)
    if (fatal.length === 0) return nothing
    return html`
      <div class="errors reveal" style="animation-delay:560ms">
        <div class="eh">⚠ Validation errors</div>
        <ul>${fatal.map((v) => html`<li>${v}</li>`)}</ul>
      </div>
    `
  }

  render (): TemplateResult {
    const c2paResult = this._c2paResult
    if (c2paResult == null) {
      return html`<div id="card">No c2pa result</div>`
    }
    const tone = this.status?.tone ?? 'authentic'
    const activeManifest = c2paResult.manifestStore.manifests[c2paResult.manifestStore.activeManifest]
    let mediaType = (c2paResult.source?.type ?? 'unknown/unknown').split('/')[0]
    mediaType = mediaType.charAt(0).toUpperCase() + mediaType.slice(1)
    const format = c2paResult.source?.type ?? ''
    const thumbnailUrl = this.thumbprintUrl ?? chrome.runtime.getURL('icons/video.svg')
    const pillars = c2paResult.durablePillars ?? null

    // Pillars reveal after the log rows + a small beat.
    const pillarsDelay = 4 * 110 + 200

    const trusted = this.status?.trusted === true
    const hasErrors = this.status?.errors === true
    // #161: same qualifier as the trust row in renderLog. A trust-list match
    // with an expired cert and no trusted timestamp must not be announced as
    // plain "Trusted".
    const tsOk = (c2paResult.tstTokens?.length ?? 0) > 0 && c2paResult.tsaTrustList != null
    const expiredNoTs = this.status?.expired === true && !tsOk
    // #128/#129: a plain-text, screen-reader summary in THIS shadow root (not the
    // nested typewriter). Makes the verdict announceable via aria-live and keeps
    // the signer + trust state available to overlay.shadowRoot.textContent.
    const srSummary = `${mediaType} signed by ${this.signer ?? 'unknown'}. ` +
      (trusted
        ? expiredNoTs
            ? `Signer in trust list ${this.trustList ?? ''}, but its certificate has expired and no trusted timestamp covers the signature.`
            : `Trusted: ${this.trustList ?? ''}.`
        : 'Signer unknown to your trust list.') +
      (hasErrors ? ' Validation errors present.' : '')

    return html`
    <div id="card">
      <div class="sr-summary" role="status" aria-live="polite">${srSummary}</div>
      <div class="header reveal" style="animation-delay:0ms">
        <div class="header-left">
          <span class="brand">Content Credentials</span>
        </div>
        <span class="status-badge ${tone}">${tone}</span>
      </div>

      <div class="title reveal" style="animation-delay:80ms">
        <div class="thumbnailFrame">
          <img class="thumbnail" src="${thumbnailUrl}" alt="">
        </div>
        <div>
          <div class="media-line">${mediaType}${activeManifest?.title != null && activeManifest.title !== '' ? html` · ${activeManifest.title}` : ''}</div>
          <div class="media-sub">${format}</div>
        </div>
      </div>

      ${this.renderLog(c2paResult)}

      ${pillars != null
        ? html`<c2pa-pillars class="reveal" style="animation-delay:${pillarsDelay}ms; display:block" .pillars=${pillars} .signerTrusted=${this.status?.trusted === true}></c2pa-pillars>`
        : nothing}

      ${this.renderErrors(c2paResult.manifestStore.validationStatus)}

      <!--
        The provenance graph is the thing this extension does that a padlock
        icon cannot. It used to sit two clicks down: inside .additional-info,
        behind "View more", then inside a collapsed "Provenance chain" section.
        Almost nobody dug that far, so the headline capability was invisible in
        normal use. It now opens with the panel. The grid fallback stays under
        "View more" for assets whose store yields no graph.
      -->
      ${(() => {
        const graph = c2paResult.provenanceGraph
        if (graph == null || graph.nodes.length === 0) return nothing
        return html`
          <div class="provenance-feature reveal" style="animation-delay:${pillarsDelay + 120}ms">
            <div class="provenance-feature-label">Provenance chain</div>
            <c2pa-provenance-graph .graph=${graph}></c2pa-provenance-graph>
          </div>
        `
      })()}

      <div class="footer reveal" style="animation-delay:${pillarsDelay + 160}ms">
        <span>Inspect on <span class="link" @click="${this.handleClick}">Verifieddit</span></span>
        <!--
          The one route from "I can verify other people's content" to "I could
          sign my own". A plain outbound link the user chooses to click: no new
          permission, no request made on its own, and the extension records
          nothing about whether it is used. The ?src= is disclosed in the
          trusteddit.com privacy policy, section 2.5.
        -->
        <a
          class="link sign-cta"
          href="${taggedLink(TRUSTEDDIT_LINK, 'extension-panel')}"
          target="_blank"
          rel="noopener noreferrer"
        >Sign your own content with Trusteddit</a>
      </div>

      <div class="additional-info">
        <c2pa-collapsible>
          <span slot="header">Edits and Activity</span>
          <div slot="content"><c2pa-grid-display .items="${activityItems(this.c2paResult?.editsAndActivity ?? undefined)}"></c2pa-grid-display></div>
        </c2pa-collapsible>
        ${(() => {
          // #131: the graph and the grid are alternatives, never both. The graph
          // is built upstream in c2pa.ts from the RAW c2pa-rs store, so it
          // carries assertions, sensor telemetry, relationships and
          // per-ingredient validation that the flattened result drops. When we
          // have one it is rendered above, in the panel proper; this collapsible
          // only carries the ingredient grid for stores that yield no graph.
          const graph = c2paResult.provenanceGraph
          if (graph != null && graph.nodes.length > 0) return nothing
          return html`
            <c2pa-collapsible>
              <span slot="header">Provenance chain</span>
              <div slot="content">
                <c2pa-grid-display .items="${ingredientItems(activeManifest.ingredients)}"></c2pa-grid-display>
              </div>
            </c2pa-collapsible>
          `
        })()}
        <c2pa-collapsible>
          <span slot="header">Signature</span>
          <div slot="content"><c2pa-grid-display .items="${signatureItems(activeManifest.signatureInfo ?? null)}"></c2pa-grid-display></div>
        </c2pa-collapsible>
        <c2pa-collapsible>
          <span slot="header">Certificates</span>
          <div slot="content"><c2pa-grid-display .items="${certificateItems(this.c2paResult?.certChain ?? [])}"></c2pa-grid-display></div>
        </c2pa-collapsible>
      </div>

      <button class="more" @click="${this.toggleAdditionalInfo}">
        ${this.additionalInfoCollapsed ? 'View more' : 'View less'}
      </button>
    </div>
    `
  }

  public close (): void {
    if (!this.additionalInfoCollapsed) {
      this.toggleAdditionalInfo()
    }
  }
}

/* ── Typewriter ─────────────────────────────────────────────────────────────
 * Character-by-character reveal of a monospace value. Ported from the
 * trusteddit.com verifier. Respects prefers-reduced-motion (renders instantly).
 */
@customElement('c2pa-typewriter')
export class C2paTypewriter extends LitElement {
  @property({ type: String }) text = ''
  @property({ type: Number }) speed = 14
  @property({ type: Number }) startDelay = 0
  @property({ type: Boolean }) caret = true

  @state() private shown = 0
  @state() private done = false

  private interval?: ReturnType<typeof setInterval>
  private starter?: ReturnType<typeof setTimeout>

  static styles = css`
    :host { display: inline; }
    .caret {
      margin-left: 1px;
      display: inline-block;
      width: 0.5ch;
      color: #7dd3fc;
      animation: blink 1s steps(1, end) infinite;
    }
    @keyframes blink { 50% { opacity: 0; } }
    @media (prefers-reduced-motion: reduce) { .caret { animation: none; } }
  `

  private prefersReducedMotion (): boolean {
    return typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  }

  private clearTimers (): void {
    if (this.interval != null) clearInterval(this.interval)
    if (this.starter != null) clearTimeout(this.starter)
    this.interval = undefined
    this.starter = undefined
  }

  private run (): void {
    this.clearTimers()
    if (this.prefersReducedMotion() || this.text === '') {
      this.shown = this.text.length
      this.done = true
      return
    }
    this.shown = 0
    this.done = false
    this.starter = setTimeout(() => {
      this.interval = setInterval(() => {
        this.shown += 1
        if (this.shown >= this.text.length) {
          this.clearTimers()
          this.done = true
        }
      }, this.speed)
    }, this.startDelay)
  }

  firstUpdated (): void {
    this.run()
  }

  willUpdate (changed: PropertyValues): void {
    if (changed.has('text') && this.hasUpdated) {
      this.run()
    }
  }

  disconnectedCallback (): void {
    super.disconnectedCallback()
    this.clearTimers()
  }

  render (): TemplateResult {
    return html`<span>${this.text.slice(0, this.shown)}</span>${this.caret && !this.done ? html`<span class="caret">▋</span>` : ''}`
  }
}

/* ── Durable Content Credentials — the 3 pillars ────────────────────────────
 * Three cells: Signed & timestamped, Durable watermark, Cloud-recoverable.
 * Active pillars glow emerald; inactive ones dim. Mirrors trusteddit.com.
 */
const PILLAR_DEFS: Array<{
  key: keyof DurablePillars
  label: string
  sub: string
  icon: TemplateResult
  /** Plain-language explanation, shown when the pillar is clicked. */
  detail: string
  /** True when confirming this pillar requires sending anything off-device. */
  needsConsent?: boolean
}> = [
  {
    key: 'signedAndTimestamped',
    label: 'Signed & timestamped',
    sub: 'C2PA + RFC 3161',
    detail: 'The file carries a cryptographic signature and a trusted timestamp proving when it was signed. Checked entirely on your device; nothing is sent anywhere.',
    icon: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 12 2 2 4-4"/><circle cx="12" cy="12" r="9"/></svg>`
  },
  {
    key: 'trustmark',
    label: 'Durable watermark',
    sub: 'TrustMark soft binding',
    detail: 'The file declares an invisible watermark, so its credential can be recovered even if the metadata is stripped by a re-encode or a screenshot. Read from the signed manifest on your device; nothing is sent anywhere.',
    icon: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 11a1.8 1.8 0 0 1 1.8 1.8c0 1.9-.2 3.6-.9 5.2"/><path d="M9.2 11.6a3 3 0 0 1 5.6 1.2c0 2.6-.3 4.6-1.1 6.6"/><path d="M6.6 12a5.4 5.4 0 0 1 10.8 0c0 1.4-.1 2.8-.5 4.1"/><path d="M4.6 13.2a7.4 7.4 0 0 1 14.8-.6"/></svg>`
  },
  {
    key: 'manifestStore',
    label: 'Cloud-recoverable',
    sub: 'manifest store · probe',
    needsConsent: true,
    detail: 'Confirming this means asking manifests.sanmarcsoft.com whether a credential is actually registered for this image. That request sends a perceptual fingerprint of the image — a short hash, never the image itself, and nothing identifying you or your device. It is off until you turn it on.',
    icon: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></svg>`
  }
]

type PillarState = 'on' | 'declared' | 'off'

@customElement('c2pa-pillars')
export class C2paPillars extends LitElement {
  @property({ type: Object }) pillars: DurablePillars | null = null
  // Durability is only a TRUST positive when the signer is itself trusted.
  // When false, the pillars are shown but flagged as self-asserted (issue #113).
  @property({ type: Boolean }) signerTrusted = false
  /** Which pillar's explanation is open, if any. */
  @state() private openPillar: keyof DurablePillars | null = null
  /** Mirrors the stored opt-in so the panel can show the right action. */
  @state() private probeEnabled = false

  connectedCallback (): void {
    super.connectedCallback()
    void chrome.storage?.local?.get(MANIFEST_STORE_PROBE_KEY).then((r) => {
      this.probeEnabled = r?.[MANIFEST_STORE_PROBE_KEY] ?? MANIFEST_STORE_PROBE_DEFAULT
    }).catch(() => { this.probeEnabled = MANIFEST_STORE_PROBE_DEFAULT })
  }

  private togglePillar (key: keyof DurablePillars): void {
    this.openPillar = this.openPillar === key ? null : key
  }

  /**
   * Record consent and turn the probe on. Deliberately does NOT re-check the
   * asset in front of the user: consent applies from here forward, so granting
   * it never retroactively sends a fingerprint for something already on screen.
   */
  private enableProbe (): void {
    this.probeEnabled = true
    try {
      void chrome.runtime.sendMessage({ action: MSG_SET_MANIFEST_STORE_PROBE, data: true })
    } catch { /* context gone; the switch in Options remains available */ }
  }

  static styles = [
    sharedStyles,
    css`
      :host { display: block; }
      .wrap {
        margin-top: 14px;
        border: 1px solid var(--border-color);
        border-radius: 10px;
        background: rgba(2, 6, 23, 0.4);
        padding: 10px;
      }
      .head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 10px;
      }
      .head .label {
        font-size: 10px;
        font-weight: var(--font-bold);
        letter-spacing: 0.1em;
        text-transform: uppercase;
        color: var(--text);
      }
      .chip {
        border-radius: 4px;
        padding: 2px 7px;
        font-size: 9px;
        font-weight: var(--font-bold);
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .chip.on  { background: rgba(16, 185, 129, 0.16); color: var(--ok); }
      .chip.off { background: rgba(51, 65, 85, 0.4); color: var(--text-dim); }

      .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
      .cell {
        position: relative;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 6px;
        text-align: center;
        border: 1px solid var(--border-color);
        border-radius: 8px;
        padding: 10px 6px;
        transition: border-color 0.3s ease, background 0.3s ease, opacity 0.3s ease;
      }
      .cell.on  { border-color: rgba(16, 185, 129, 0.3); background: rgba(16, 185, 129, 0.06); }
      .cell.declared { border-color: rgba(245, 158, 11, 0.3); background: rgba(245, 158, 11, 0.06); }
      .cell.off { background: rgba(15, 23, 42, 0.35); opacity: 0.55; }

      .cell svg { width: 22px; height: 22px; }
      .cell.on  svg { color: var(--ok); filter: drop-shadow(0 0 6px var(--ok-glow)); }
      .cell.declared svg { color: var(--warn); }
      .cell.off svg { color: var(--text-dim); }

      .cell .l { font-size: 9.5px; font-weight: var(--font-bold); line-height: 1.2; }
      .cell.on  .l { color: var(--text-bright); }
      .cell.declared .l { color: var(--text-bright); }
      .cell.off .l { color: var(--text-dim); }
      /* Sublabel: lift to slate-400 for AA contrast on the glass (#94a3b8). */
      .cell .s { font-size: 9px; letter-spacing: 0.04em; text-transform: uppercase; color: #94a3b8; }

      .badge {
        margin-top: 2px;
        font-size: 8px;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--warn);
      }
      .glyph { font-weight: 700; }

      /* Cells are buttons now; make that legible without shouting. */
      .cell { cursor: pointer; }
      .cell:hover { border-color: rgba(148, 163, 184, 0.55); }
      .cell:focus-visible { outline: 2px solid var(--ok); outline-offset: 2px; }
      .cell.open { border-color: rgba(148, 163, 184, 0.7); }
      .more-dot { font-size: 8px; color: #94a3b8; line-height: 1; }

      .detail {
        margin-top: 8px;
        border: 1px solid var(--border-color);
        border-radius: 6px;
        background: rgba(15, 23, 42, 0.5);
        padding: 8px 10px;
      }
      .detail p { margin: 0; font-size: 10px; line-height: 1.5; color: #cbd5e1; }
      /* A request to send something off-device is marked as such, not slipped in. */
      .detail.consent {
        border-color: rgba(245, 158, 11, 0.4);
        background: rgba(245, 158, 11, 0.08);
      }
      .detail.consent p { color: var(--warn); }
      .opt-in {
        margin-top: 8px;
        font: inherit;
        font-size: 10px;
        font-weight: var(--font-bold);
        color: var(--text-bright);
        background: transparent;
        border: 1px solid var(--border-strong);
        border-radius: 6px;
        padding: 5px 10px;
        cursor: pointer;
      }
      .opt-in:hover { background: var(--glass-bg-soft); }
      .opt-in-note { display: block; margin-top: 6px; font-size: 9px; color: #94a3b8; line-height: 1.45; }

      .note { margin-top: 8px; font-size: 10px; line-height: 1.45; color: #94a3b8; }
      .note.warn {
        margin-top: 8px;
        border: 1px solid rgba(245, 158, 11, 0.3);
        background: rgba(245, 158, 11, 0.08);
        border-radius: 6px;
        padding: 6px 8px;
        color: var(--warn);
      }
      @media (prefers-reduced-motion: reduce) { .cell { transition: none; } }
    `]

  private stateFor (p: DurablePillars, key: keyof DurablePillars): PillarState {
    if (key === 'manifestStore') {
      return p.manifestStore === 'verified' ? 'on' : p.manifestStore === 'declared' ? 'declared' : 'off'
    }
    return p[key] === true ? 'on' : 'off'
  }

  render (): TemplateResult | typeof nothing {
    const p = this.pillars
    if (p == null) return nothing
    const glyph = (s: PillarState): string => s === 'on' ? '✓' : s === 'declared' ? '?' : '✗'
    return html`
      <div class="wrap">
        <div class="head">
          <span class="label">Durable Content Credentials</span>
          <span class="chip ${p.durable && this.signerTrusted ? 'on' : 'off'}">${p.count}/3 verified</span>
        </div>
        <div class="grid">
          ${PILLAR_DEFS.map((def) => {
            const st = this.stateFor(p, def.key)
            const open = this.openPillar === def.key
            // Every pillar explains itself on click. A durability claim the
            // reader cannot interrogate is just a badge, and this product is
            // in no position to ask for trust it will not itself account for.
            return html`
              <div
                class="cell ${st} ${open ? 'open' : ''}"
                role="button"
                tabindex="0"
                aria-expanded="${open ? 'true' : 'false'}"
                title="What does this mean?"
                @click="${() => { this.togglePillar(def.key) }}"
                @keydown="${(e: KeyboardEvent) => {
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.togglePillar(def.key) }
                }}"
              >
                ${def.icon}
                <span class="l"><span class="glyph">${glyph(st)}</span> ${def.label}</span>
                <span class="s">${def.sub}</span>
                ${st === 'declared' ? html`<span class="badge">declared · unverified</span>` : nothing}
                <span class="more-dot" aria-hidden="true">${open ? '▴' : '▾'}</span>
              </div>
            `
          })}
        </div>
        ${(() => {
          if (this.openPillar == null) return nothing
          const def = PILLAR_DEFS.find((d) => d.key === this.openPillar)
          if (def == null) return nothing
          const needsOptIn = def.needsConsent === true && !this.probeEnabled
          return html`
            <div class="detail ${needsOptIn ? 'consent' : ''}">
              <p>${def.detail}</p>
              ${def.needsConsent === true
                ? (needsOptIn
                    ? html`
                      <button class="opt-in" @click="${(e: Event) => { e.stopPropagation(); this.enableProbe() }}">
                        Turn on the online check
                      </button>
                      <span class="opt-in-note">Applies from now on. This image is not re-checked, so nothing is sent for it.</span>`
                    : html`<span class="opt-in-note">On. Turn it off again in the extension's Options tab.</span>`)
                : nothing}
            </div>
          `
        })()}
        ${!this.signerTrusted
          ? html`<p class="note warn">⚠ Signer is not in a trust list — these durability features are self-asserted by the signer, not independently verified.</p>`
          : nothing}
        ${p.manifestStore === 'declared' && this.probeEnabled
          ? html`<p class="note">Cloud recovery is declared in the manifest but the registration was not confirmed — the store had no match, or it could not be reached.</p>`
          : nothing}
        ${!p.durable
          ? html`<p class="note">${p.embedOnly
              ? 'Embed-only credential — the signature is valid, but with no durable binding it is lost if the file is re-encoded or stripped.'
              : 'Not all durability pillars are present.'}</p>`
          : nothing}
      </div>
    `
  }
}

@customElement('c2pa-collapsible')
export class C2paCollapsible extends LitElement {
  @property({ type: Boolean }) open = false

  static openCollapsible: C2paCollapsible | null = null

  static styles = [
    sharedStyles,
    innerHostStyles,
    css`
    .collapsible-header {
      cursor: pointer;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-weight: var(--font-bold);
      font-size: 12px;
      color: var(--text);
      padding: 4px 0;
    }
    .collapsible-content {
      overflow: hidden;
      max-height: 0;
      transition: max-height 0.3s ease, padding 0.3s ease;
      padding: 0 0 0 14px;
    }
    /* Was 400px, which cropped the diagram's control row (#141): the graph
     * canvas alone is 360px and the section adds padding, so the zoom / Fit /
     * Full screen row fell outside the cap. Overflow is only needed while the
     * height animates. */
    .collapsible-content.open { max-height: 900px; overflow: visible; }
    .icon {
      transition: transform 0.3s ease;
      width: 10px;
      height: 10px;
      transform-origin: center;
      display: inline-block;
      transform: rotate(270deg);
    }
    .icon path { fill: var(--text-dim); }
    .rotated { transform: rotate(180deg); }
  `]

  static close (): void {
    if (C2paCollapsible.openCollapsible != null) {
      C2paCollapsible.openCollapsible.toggle()
    }
  }

  toggle = (): void => {
    if (C2paCollapsible.openCollapsible != null && C2paCollapsible.openCollapsible !== this) {
      C2paCollapsible.openCollapsible.toggle()
    }
    this.open = !this.open
    C2paCollapsible.openCollapsible = this.open ? this : null
  }

  render (): TemplateResult {
    return html`
      <div class="collapsible-container">
        <div class="collapsible-header" @click="${this.toggle}">
          <span class="section-title"><slot name="header">Default Header</slot></span>
          ${this.open ? this.renderIcon('open') : this.renderIcon('closed')}
        </div>
        <div class="collapsible-content ${this.open ? 'open' : ''}">
          <slot name="content">Default Content</slot>
        </div>
      </div>
    `
  }

  renderIcon (state: 'open' | 'closed'): TemplateResult {
    const iconClass = state === 'open' ? 'icon rotated' : 'icon'
    return html`<svg class="${iconClass}" viewBox="0 0 512 512">
      <g stroke="none" stroke-width="1" fill="none" fill-rule="evenodd">
          <g transform="translate(32.000000, 42.666667)">
              <path d="M246.312928,5.62892705 C252.927596,9.40873724 258.409564,14.8907053 262.189374,21.5053731 L444.667042,340.84129 C456.358134,361.300701 449.250007,387.363834 428.790595,399.054926 C422.34376,402.738832 415.04715,404.676552 407.622001,404.676552 L42.6666667,404.676552 C19.1025173,404.676552 7.10542736e-15,385.574034 7.10542736e-15,362.009885 C7.10542736e-15,354.584736 1.93772021,347.288125 5.62162594,340.84129 L188.099293,21.5053731 C199.790385,1.04596203 225.853517,-6.06216498 246.312928,5.62892705 Z"></path>
          </g>
      </g>
    </svg>`
  }
}

@customElement('c2pa-grid-display')
export class C2paGridDisplay extends LitElement {
  @property({ type: Array }) items: IconTextItem[] = []

  static styles = [
    sharedStyles,
    css`
      .grid-container {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 8px 16px;
        align-items: center;
        margin: 8px 0;
      }
      .icon {
        width: 18px;
        height: 18px;
        grid-row: span 1;
        opacity: 0.85;
      }
      img { width: 100%; height: 100%; object-fit: cover; border-radius: 3px; }
      .text-block { display: flex; flex-direction: column; justify-content: center; }
      .text-line { font-size: 11px; color: var(--text); margin-bottom: 0; }
    `]

  render (): TemplateResult {
    return html`
      <div class="grid-container">
        ${this.items.map((item, index) => html`
          <div class="icon" style="grid-row: ${index + 1};">
            ${item.icon != null ? html`<img src="${item.icon}" alt="Icon">` : ''}
          </div>
          <div class="text-block" style="grid-row: ${index + 1};">
            ${item.text.map(line => html`<div class="text-line">${line}</div>`)}
          </div>
        `)}
      </div>
    `
  }
}

const unknownSvg = 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20height%3D%2218%22%20viewBox%3D%220%200%2018%2018%22%20width%3D%2218%22%3E%20%20%3Cdefs%3E%20%20%20%20%3Cstyle%3E%20%20%20%20%20%20.fill%20%7B%20%20%20%20%20%20%20%20fill%3A%20%236E6E6E%3B%20%20%20%20%20%20%7D%20%20%20%20%3C%2Fstyle%3E%20%20%3C%2Fdefs%3E%20%20%3Ctitle%3ES%20AlertCircle%2018%20N%3C%2Ftitle%3E%20%20%3Crect%20id%3D%22Canvas%22%20fill%3D%22%23ff13dc%22%20opacity%3D%220%22%20width%3D%2218%22%20height%3D%2218%22%20%2F%3E%3Cpath%20class%3D%22fill%22%20d%3D%22M7.84555%2C12.88618a1.13418%2C1.13418%2C0%2C0%2C1%2C1.1161-1.15195q.042-.00064.08391.00178a1.116%2C1.116%2C0%2C0%2C1%2C1.2%2C1.15017%2C1.09065%2C1.09065%2C0%2C0%2C1-1.2%2C1.11661%2C1.0908%2C1.0908%2C0%2C0%2C1-1.2-1.11661ZM10.0625%2C4.39771a.20792.20792%2C0%2C0%2C1%2C.09966.183V5.62212c0%2C1.40034-.28322%2C3.98034-.33305%2C4.48067%2C0%2C.04984-.01678.09967-.11695.09967H8.379a.11069.11069%2C0%2C0%2C1-.11695-.09967c-.03305-.46678-.3-3.0305-.3-4.43084V4.6306a.1773.1773%2C0%2C0%2C1%2C.08339-.18306%2C2.88262%2C2.88262%2C0%2C0%2C1%2C1.00017-.20033A3.27435%2C3.27435%2C0%2C0%2C1%2C10.0625%2C4.39771ZM17.50005%2C9A8.50005%2C8.50005%2C0%2C1%2C1%2C9%2C.5H9A8.50008%2C8.50008%2C0%2C0%2C1%2C17.50005%2C9ZM15.67484%2C9A6.67485%2C6.67485%2C0%2C1%2C0%2C9%2C15.6748H9A6.67479%2C6.67479%2C0%2C0%2C0%2C15.67484%2C9Z%22%20%2F%3E%3C%2Fsvg%3E'

const signSvg = 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20height%3D%2218%22%20viewBox%3D%220%200%2018%2018%22%20width%3D%2218%22%3E%20%20%3Cdefs%3E%20%20%20%20%3Cstyle%3E%20%20%20%20%20%20.fill%20%7B%20%20%20%20%20%20%20%20fill%3A%20%236E6E6E%3B%20%20%20%20%20%20%7D%20%20%20%20%3C%2Fstyle%3E%20%20%3C%2Fdefs%3E%20%20%3Ctitle%3ES%20Draw%2018%20N%3C%2Ftitle%3E%20%20%3Crect%20id%3D%22Canvas%22%20fill%3D%22%23ff13dc%22%20opacity%3D%220%22%20width%3D%2218%22%20height%3D%2218%22%20%2F%3E%3Cpath%20class%3D%22fill%22%20d%3D%22M10.227%2C4%2C2.542%2C11.686a.496.496%2C0%2C0%2C0-.1255.2105L1.0275%2C16.55c-.057.188.2295.425.3915.425a.15587.15587%2C0%2C0%2C0%2C.031-.003c.138-.032%2C3.9335-1.172%2C4.6555-1.389a.492.492%2C0%2C0%2C0%2C.2075-.125L14%2C7.772ZM5.7%2C14.658c-1.0805.3245-2.431.7325-3.3645%2C1.011L3.34%2C12.304Z%22%20%2F%3E%20%20%3Cpath%20class%3D%22fill%22%20d%3D%22M16.7835%2C4.1%2C13.9%2C1.216a.60751.60751%2C0%2C0%2C0-.433-.1765H13.45a.686.686%2C0%2C0%2C0-.4635.2035l-2.05%2C2.05L14.708%2C7.0645l2.05-2.05a.686.686%2C0%2C0%2C0%2C.2-.4415A.612.612%2C0%2C0%2C0%2C16.7835%2C4.1Z%22%20%2F%3E%3C%2Fsvg%3E'

function certificateItems (certificates: CertificateInfoExtended[]): IconTextItem[] {
  return certificates.map((cert) => {
    return {
      icon: 'icons/seal.svg',
      text: [cert.issuer.CN, cert.issuer.O, `${cert.validFrom} - ${cert.validTo}`]
    }
  })
}

function signatureItems (signature: { issuer: string }): IconTextItem[] {
  if (signature == null) {
    return [{
      icon: unknownSvg,
      text: ['None']
    }]
  }
  return [{
    icon: signSvg,
    text: [
      signature.issuer ?? 'unknown'
    ]
  }]
}

function ingredientItems (ingredients: ExtensionC2paIngredient[] | undefined): IconTextItem[] {
  if (ingredients == null || ingredients.length === 0) {
    return [{
      icon: unknownSvg,
      text: ['None']
    }]
  }
  return ingredients.map((ingredient) => {
    return {
      icon: ingredient.thumbnail.data,
      text: [
        ingredient.title,
        ingredient.format
      ]
    }
  })
}

function activityItems (activities: Activity[] | undefined): IconTextItem[] {
  if (activities == null || activities.length === 0) {
    return [{
      icon: unknownSvg,
      text: ['None']
    }]
  }
  return activities.map((activity) => {
    return {
      icon: activity.icon,
      text: [activity.description]
    }
  })
}
