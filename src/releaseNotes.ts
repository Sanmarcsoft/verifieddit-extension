/*
 * Single source of truth for the "What's new" section in the About tab.
 *
 * Public-facing copy. No internal QA / Playwright / test-fixture language;
 * the popup renders this verbatim to end users. The "How to verify" lines
 * are written as something a user can actually try on the web today.
 *
 * Add a new object at the top of RELEASE_NOTES for every shipped version.
 * Newest first; popup.ts renders the first entry expanded by default.
 */

export interface ReleaseFix {
  title: string
  /**
   * Plain-English action a user can take to see the feature in action.
   * Optional `verifyFragment` deep-links to a demo image fixture by name.
   */
  howToVerify: string
  verifyFragment?: string
}

export interface ReleaseEntry {
  tag: string
  date: string
  summary: string
  fixes: ReleaseFix[]
}

export const DEMO_URL = 'https://www.verifieddit.com/demo'

export const RELEASE_NOTES: readonly ReleaseEntry[] = [
  {
    tag: 'v1.2.3',
    date: '2026-09-01',
    summary: 'Badges survive scrolling, and an expired signing certificate is never presented as plainly trusted.',
    fixes: [
      {
        title: 'Badges come back when you scroll back',
        howToVerify:
          'On a long page with auto-scan enabled, scroll away from a checked image and return to it. Its badge is recreated, including for images that carried no credentials at all. Previously any image whose result was "no credentials found" or "verification failed" lost its badge permanently the first time it left the screen.'
      },
      {
        title: 'An expired signing certificate is called out in the panel',
        howToVerify:
          'Open the panel on a file whose signing certificate has expired without a trusted timestamp. The trust line now reads "cert expired, no trusted timestamp" instead of an unqualified checkmark, and the spoken summary for screen readers says the same.'
      }
    ]
  },
  {
    tag: 'v1.2.2',
    date: '2026-09-01',
    summary: 'Content signed by real-world tools (Photoshop, Firefly, Lightroom, Truepic) is now recognised as trusted.',
    fixes: [
      {
        title: 'Adobe- and Truepic-signed content shows a trusted signer',
        howToVerify:
          'Open an image exported from a current Photoshop, Lightroom or Firefly with Content Credentials attached, or any of the example images at contentcredentials.org/verify. The signer panel now reports it as trusted. Previously every one of these rendered as "valid but the signer is not on any trust list", because the extension bundled only the C2PA conformance anchors and not the known-certificate list that real production signers chain to.'
      },
      {
        title: 'Trust anchors added in updates now reach existing installs',
        howToVerify:
          'If you installed before v1.2.0, media signed via trusteddit.com previously stayed untrusted until you reinstalled from scratch. Updating the extension is now enough: newly bundled anchors are merged into your profile on every update.'
      },
      {
        title: 'One damaged trust record no longer disables trust checking',
        howToVerify:
          'Nothing to do: this is a resilience fix. If a stored trust list ever became unreadable, the extension used to stop loading all trust anchors and silently kept stale ones. It now skips the damaged record and carries on.'
      }
    ]
  },
  {
    tag: 'v1.2.1',
    date: '2026-08-11',
    summary: 'The panel opens for everyone, and the provenance graph can be arranged by hand.',
    fixes: [
      {
        title: 'The panel\'s sections open again with "reduce motion" turned on',
        howToVerify:
          'Open the panel on any signed file, click "View more", then click any section heading. Edits and Activity, Signature and Certificates each open and stay open. If your system is set to reduce motion, these headings previously looked like dead controls: the section did open, but the panel stayed clipped to its old height so nothing appeared.'
      },
      {
        title: 'Drag a node in the provenance graph to move it',
        howToVerify:
          'Open the panel on a signed file and expand "Provenance chain". Press a node and drag: it follows the cursor and its arrows come with it, so you can pull apart overlapping nodes and read what was hidden behind them. A "Reset layout" button appears once you have moved anything, and puts everything back.',
        verifyFragment: '07-edge-realworld-cbc-signed'
      },
      {
        title: '"Fit" fills the screen in full-screen view',
        howToVerify:
          'In the provenance graph, click "Full screen", then "Fit". The chain now scales up to fill the display instead of sitting small in the middle of an empty canvas.'
      },
      {
        title: 'The panel works on pages that were already open',
        howToVerify:
          'Reload or update the extension with tabs already open, then verify an image on one of them. The panel appears. It could previously have nowhere to draw on a page that finished loading before the extension attached.'
      }
    ]
  },
  {
    tag: 'v1.2.0',
    date: '2026-08-11',
    summary: 'The popup lists everything it looked at, not only what turned out to be signed.',
    fixes: [
      {
        title: 'Every file the extension analysed is listed',
        howToVerify:
          'Open the Verifieddit toolbar icon on any ordinary page, a news article or a shop. You now get one row per image, video and audio file, whatever the outcome. The popup used to show only files that turned out to be signed, so on most pages it sat on "Scanning..." forever with nothing to report.'
      },
      {
        title: 'Files with no Content Credentials say so, quietly',
        howToVerify:
          'Look for the "No Creds" badge. Those rows are dimmed, and come to full strength when you hover or tab to them. Absence of a signature is a real finding, but a weaker one than any verdict about a signature that exists.'
      },
      {
        title: '"No credentials" and "could not check" are no longer the same answer',
        howToVerify:
          'A file the extension could not read now reads "Unchecked" rather than being reported as unsigned. Telling you a signed file carries no credentials is the worst mistake a verifier can make, so the two are kept apart.'
      },
      {
        title: 'Right-click, "Verify with Verifieddit" works again',
        howToVerify:
          'Right-click any image on any site and choose "Verify with Verifieddit". A badge appears on the image with the verdict. It now works on wrapped figures, responsive images, and the transparent click-catching layers most news sites put over their photographs, and it tells you when a check fails instead of doing nothing at all.'
      }
    ]
  },
  {
    tag: 'v1.1.1',
    date: '2026-08-03',
    summary: 'The one thing that phoned home now asks first, and the AI label says only what it can prove.',
    fixes: [
      {
        title: 'Nothing is sent unless you ask for it',
        howToVerify:
          'Open the panel on any signed file and click "Cloud-recoverable" under Durable Content Credentials. It explains that confirming it means sending a fingerprint of the image to our manifest store, and lets you turn that on. Until you do, the extension makes no request you did not start with a click. You can change your mind in the Options tab.'
      },
      {
        title: 'Every durability check explains itself',
        howToVerify:
          'Click any of the three pillars in the panel. Each says in plain language what it means and whether confirming it involves sending anything.'
      },
      {
        title: 'The AI row says "declared", because that is what it knows',
        howToVerify:
          'Open the popup and look at the row now labelled "AI (declared by signer)". It reports what a signer wrote in their own signed manifest. A file with no such declaration reads "not declared" rather than "no", because nothing here inspects pixels and an absent declaration is not proof of human authorship.'
      }
    ]
  },
  {
    tag: 'v1.1.0',
    date: '2026-08-03',
    summary: 'Interactive provenance graph, a rebuilt popup, and a trust list resynced with the C2PA Conformance Program.',
    fixes: [
      {
        title: 'Interactive provenance graph replaces the flat ingredient list',
        howToVerify:
          'Click any badge to open the panel. The chain of custody is now a graph you can explore: click a node to expand its detail, drag to pan, scroll or use +/- to zoom, Fit to frame the whole chain, Full screen for a closer look, Escape to come back. It shows multi-generation ingredient history, assertion and sensor-telemetry nodes, and the relationship between each step.',
        verifyFragment: '07-edge-realworld-cbc-signed'
      },
      {
        title: 'The graph is in the popup too, and the popup matches the website',
        howToVerify:
          'Click the Verifieddit toolbar icon. The Validation tab now shows the provenance graph for media on the page you are viewing, and the tabs are styled to match verifieddit.com rather than the browser default.'
      },
      {
        title: 'More signers are recognised as trusted',
        howToVerify:
          'Open the Trust Lists tab. The bundled list now carries all 29 anchors from the C2PA Conformance Program, plus the 21 official timestamp authorities. Media signed by Huawei, Huanyu, Verimago, Snowball, Encypher, TrustAsia or RealReel previously showed as valid-but-unknown; it now resolves to a named, trusted signer.'
      },
      {
        title: 'Only genuinely AI-generated media is labelled as AI',
        howToVerify:
          'The AI marker now comes from what a file declares about itself in its Content Credentials, not from which company signed it. Previously anything signed under certain corporate certificate authorities was marked AI-generated, including ordinary photographs, and AI images from other tools were missed.'
      },
      {
        title: 'Test-signing keys are no longer trusted in the published build',
        howToVerify:
          'The demo fixtures shipped with the source are signed by a development key that lives in the public repository. That key is no longer loaded as a trust anchor in the version you install, so nothing signed with it can appear trusted to you.'
      },
      {
        title: 'Fewer permissions, and the right-click item stays put',
        howToVerify:
          'The bookmarks permission and the feature behind it are gone entirely. "Verify with Verifieddit" in your right-click menu also no longer disappears after the browser suspends the extension in the background.'
      }
    ]
  },
  {
    tag: 'v1.0.0',
    date: '2026-05-17',
    summary: 'Initial public release. Verify C2PA Content Credentials on any webpage.',
    fixes: [
      {
        title: 'Automatic detection of signed media on every page',
        howToVerify:
          'Open any page with C2PA-credentialed images (try the demo page link above). Verifieddit overlays a small badge in the corner of each verified piece of media — green for trusted, yellow for an unknown signer, red for an integrity failure.'
      },
      {
        title: 'Click a badge for the full provenance panel',
        howToVerify:
          'Click any badge to open the provenance panel: who created the content, what tools touched it, the certificate trust chain, the trusted timestamp, and the ingredient history.'
      },
      {
        title: 'Right-click to inspect any image, video, or audio',
        howToVerify:
          'Right-click any media element on any page and choose "Verify with Verifieddit." A new tab opens with the full Content Credentials inspection — works whether auto-scan is on or off.'
      },
      {
        title: '100% local processing, zero servers',
        howToVerify:
          'Every byte of verification work happens inside your browser using locally-bundled WebAssembly. No media is uploaded anywhere. No analytics, no telemetry, no account required. See the Privacy Policy linked from the listing.'
      }
    ]
  }
]
