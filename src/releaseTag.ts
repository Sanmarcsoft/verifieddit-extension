/*
 * The release a build belongs to, as the About tab shows it.
 *
 * An exact tag wins. A build a few commits past a tag belongs to that tag's release. A build whose
 * package version is ahead of the last tag is the next release, built before its tag exists, and
 * shows its own version: otherwise a 1.3.0 package announces itself as v1.2.6.
 */

export interface TagInfo { version: string, tag: string, tagDescribe: string }

function numeric (v: string): number[] {
  return v.replace(/^v/, '').split('-')[0].split('.').map((n) => Number.parseInt(n, 10) || 0)
}

function isAhead (version: string, tag: string): boolean {
  const a = numeric(version)
  const b = numeric(tag)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  }
  return false
}

export function familyTag (info: TagInfo): string {
  if (info.tag !== '') return info.tag
  const td = info.tagDescribe
  if (td == null || td === '' || td === 'unknown') return `v${info.version}`
  // Strip trailing "-<n>-g<sha>[-dirty]" if present.
  const base = td.match(/^(.+?)(?:-\d+-g[0-9a-f]+(?:-dirty)?)?$/)?.[1] ?? td
  return isAhead(info.version, base) ? `v${info.version}` : base
}
