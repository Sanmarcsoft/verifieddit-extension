/*
 * CSV and plain-text export for C2PA provenance nodes.
 *
 * Kept separate from the diagram component because it is pure: given a node it
 * returns a string, with no DOM and no lit. That makes the escaping rules
 * testable without a browser.
 *
 * WHAT IS ACTUALLY TRUE HERE, stated carefully because it is easy to overstate.
 *
 * The input is attacker-controlled. A C2PA signature binds a manifest to an
 * asset and proves who signed it; it constrains nothing about what the strings
 * inside say. `claim_generator` reaches the UI raw (provenanceGraph.ts), as do
 * assertion labels, signer fields and telemetry keys: `sanitizeLabel` is applied
 * only to node labels and Mermaid output. This extension also renders untrusted
 * and failed manifests on purpose, because saying "this is not trustworthy" is
 * the product. So hostile strings arriving here is design, not mishap.
 *
 * The payoff is smaller than the folklore. Excel has disabled DDE by default
 * since 2018, so `=cmd|'/c calc'!A0` no longer yields code execution, and a
 * downloaded file opens in Protected View besides. What survives is narrower:
 * `=HYPERLINK(...)` phishing or exfiltration on a user click, `=WEBSERVICE()`
 * where it is enabled, and LibreOffice's more permissive defaults. Data
 * integrity, not remote code execution.
 *
 * So the guard is proportionate rather than maximal. It costs three lines and
 * no runtime, so it stays. It exempts plain numbers, so exported telemetry
 * (`-33.8688` latitude, negative headings) stays numeric in the spreadsheet
 * instead of being turned into text by a reflexive apostrophe. Evidentiary
 * fidelity is the point of an export; a guard that corrupts the data it guards
 * would be the worse bug.
 */

import type { ProvenanceGraph, ProvenanceNode } from './provenanceTypes'

/** Leading characters a spreadsheet reads as the start of a formula. */
const FORMULA_LEAD = /^[=+\-@\t\r]/

/**
 * A plain number, sign and exponent included.
 *
 * `-33.8688` starts with a formula lead character and is not a formula. GPS
 * latitude, heading and rotation channels are full of these, and they are
 * exactly the fields someone exports in order to do arithmetic on them.
 */
const PLAIN_NUMBER = /^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/

/**
 * RFC 4180 encode one cell, neutralising spreadsheet formulas first.
 *
 * Neutralisation is a leading apostrophe, which every major spreadsheet reads
 * as "the rest of this cell is literal text" and hides from the rendered value.
 * Preferred over stripping the character because a claim generator really named
 * `=SUM(A1)` should still be legible as such to whoever reads the file.
 */
export function csvCell (value: string | null | undefined): string {
  if (value == null) return ''
  const text = String(value)
  const risky = FORMULA_LEAD.test(text) && !PLAIN_NUMBER.test(text)
  const guarded = risky ? `'${text}` : text
  // Quote when the value carries a delimiter, a quote, or any line break.
  // Doubling the quote is RFC 4180's own escape.
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded
}

/** Join pre-escaped cells into a CSV line. */
function csvRow (cells: Array<string | null | undefined>): string {
  return cells.map(csvCell).join(',')
}

export const CSV_HEADER = ['node_id', 'node_kind', 'node_label', 'field', 'value'] as const

/**
 * Flatten one node into tidy (long-form) rows: one row per field.
 *
 * Long form rather than one wide row per node, because assertion payloads are
 * arbitrarily deep and vary node to node. A wide table would need a column per
 * key seen anywhere in the chain and would be mostly empty.
 */
export function nodeRows (node: ProvenanceNode): string[][] {
  const rows: string[][] = []
  const push = (field: string, value: string | null | undefined): void => {
    if (value == null || value === '') return
    rows.push([node.id, node.kind, node.label, field, String(value)])
  }

  push('Title', node.title)
  push('Format', node.formatLabel)
  push('Validation state', node.validationState)
  push('Relationship', node.relationship)
  push('Active manifest', node.isActive ? 'yes' : null)
  push('Claim generator', node.claimGenerator)
  push('Claim generator tool', node.claimGeneratorTool)

  if (node.signer != null) {
    push('Signer issuer', node.signer.issuer)
    push('Signer algorithm', node.signer.alg)
    push('Signed', node.signer.time)
  }

  for (const a of node.assertions) push('Assertion', a)
  for (const f of node.dataFields ?? []) push(f.key, f.value)

  for (const v of node.validationStatus) {
    push('Validation failure', v.explanation != null && v.explanation !== ''
      ? `${v.code}: ${v.explanation}`
      : v.code)
  }

  if (node.ingredientCount > 0) push('Ingredients', String(node.ingredientCount))
  push('Instance ID', node.instanceId)

  return rows
}

/** CSV for a single node, header included so the file stands alone. */
export function nodeToCsv (node: ProvenanceNode): string {
  return [csvRow([...CSV_HEADER]), ...nodeRows(node).map(csvRow)].join('\r\n')
}

/** CSV for the whole chain, in the order the graph presents it. */
export function graphToCsv (graph: ProvenanceGraph): string {
  const rows = graph.nodes.flatMap(nodeRows)
  return [csvRow([...CSV_HEADER]), ...rows.map(csvRow)].join('\r\n')
}

/**
 * Human-readable text for the clipboard.
 *
 * Not CSV: someone copying one box is usually pasting into a note, an issue or
 * a message, so `key: value` lines read better than quoted columns. No formula
 * guard here, because the clipboard target is not a formula evaluator; the
 * guard would be noise in every paste.
 */
export function nodeToText (node: ProvenanceNode): string {
  const lines = [`${node.label}${node.title != null && node.title !== '' && node.title !== node.label ? ` (${node.title})` : ''}`]
  for (const [, , , field, value] of nodeRows(node)) lines.push(`${field}: ${value}`)
  return lines.join('\n')
}

/** Filename-safe slug so exports do not collide in the downloads folder. */
export function exportSlug (label: string): string {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return base === '' ? 'node' : base.slice(0, 48)
}

/**
 * Dated filename for a CSV export.
 *
 * Shared by the chain export and the single-step export so the two sort next to
 * each other in a downloads folder. `suffix` is what distinguishes them, and it
 * is the caller's word rather than a boolean, because a third kind of export is
 * more likely than a second meaning for `true`.
 *
 * The date is injected so this is testable without freezing the clock.
 */
export function exportFilename (label: string, suffix: string, date: Date = new Date()): string {
  return `${exportSlug(label)}-${suffix}-${date.toISOString().slice(0, 10)}.csv`
}
