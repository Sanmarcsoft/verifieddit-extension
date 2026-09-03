/*
 *  Copyright (c) Microsoft Corporation.
 *  Licensed under the MIT license.
 */

import { type CertificateInfoExtended, calculateSha256CertThumbprintFromX5c, PEMtoDER, certificateFromDer, distinguishedNameToString, verifyParentSignedChild } from './certs/certs';
import { AWAIT_ASYNC_RESPONSE, MSG_ADD_TRUSTLIST, MSG_GET_TRUSTLIST_INFOS, MSG_REMOVE_TRUSTLIST, type MSG_PAYLOAD, LOCAL_TRUST_ANCHOR_LIST_NAME, MSG_TRUSTLIST_UPDATE, LOCAL_TRUST_TSA_LIST_NAME, MSG_ADD_TRUSTFILE, MSG_ADD_TSA_TRUSTFILE , TRUST_DEV_FIXTURES } from './constants';
import { bytesToBase64, sendMessageToAllTabs } from './utils';

// Directly import the JSON files (bundled into the JS by Rollup; not shipped
// as separate files in dist/, so they cannot be enumerated by web pages).
// #125: production trust anchors live under src/trust-anchors/ (NOT test/), so
// fixtures and real roots-of-trust can never be confused or swapped.
import defaultTestTrustList from './trust-anchors/default-trust-list.json';
// Official C2PA TSA anchors (21). Generated alongside default-trust-list.json by
// scripts/sync-c2pa-trust-lists.ts; named 'Local TSA Anchors' so
// checkTSATrustListInclusion picks it up. Before this the extension carried the
// Trusteddit TSA chain only, so RFC 3161 timestamps from every official C2PA
// timestamp authority failed the trust check.
import defaultTsaTrustList from './trust-anchors/default-tsa-trust-list.json';
// CAI known-certificate anchors (contentcredentials.org/trust/anchors.pem) -
// the list Adobe's own Verify trusts. The conformance list alone carries a
// single Adobe cert (vault-a-or2) while real Photoshop/Firefly/Lightroom
// output chains through Adobe Product Services G3/G4 to Adobe Root CA G2,
// which only this list holds. Without it every legitimate Adobe-signed asset
// rendered valid-but-untrusted (found live 2026-09-01).
import caiKnownAnchors from './trust-anchors/cai-known-anchors.json';
// Fixture-signing CA for the bundled demo corpus. NOT a C2PA anchor — kept out
// of default-trust-list.json so that file is exactly the official list.
import devTrustList from './trust-anchors/dev-trust-list.json';
import defaultAiTrustList from './trust-anchors/ai-trust-list.json';
// Trusteddit.com anchors: the CA chain (signing) + the TSA chain (timestamps).
// Trusting the Trusteddit-Journalist-Issuer-CA trusts every leaf it issues.
import trustedditTrustList from './trust-anchors/trusteddit-trust-list.json';
import trustedditTsaTrustList from './trust-anchors/trusteddit-tsa-trust-list.json';

// valid JWK key types (to adhere to C2PA cert profile: https://c2pa.org/specifications/specifications/2.0/specs/C2PA_Specification.html#_certificate_profile)
type ValidKeyTypes = 'RSA' /* sha*WithRSAEncryption and id-RSASSA-PSS */ | 'EC' /* ecdsa-with-* */ | 'OKP' /* id-Ed25519 */

// JWKS format (https://www.rfc-editor.org/rfc/rfc7517#section-4.6)
interface JWK {
  kty: string
  'x5t#S256'?: string
  x5c?: string[]
}

interface JWKS {
  keys: JWK[]
}

export interface TrustedEntity {
  name: string
  display_name: string
  contact: string
  isCA: boolean
  jwks: JWKS
}

export interface TrustList {
  // version of the trust list schema
  version?: string
  // name of the trust list
  name?: string
  // description of the trust list
  description: string
  // download url of the trust list
  download_url: string
  // website of the trust list
  website: string
  // last updated date of the trust list (ISO 8601 format)
  last_updated: string
  // logo of the trust list (optional)
  logo_icon?: string
  // list of trusted entities
  entities: TrustedEntity[]
}

// trust list info (subset of the trust list data)
export interface TrustListInfo {
  version?: string
  name?: string
  description: string
  download_url: string
  website: string
  last_updated: string
  logo_icon?: string
  entities_count: number
}

/**
 * Information about a trust list match
 */
export interface TrustListMatch {
  // trust list info
  tlInfo: TrustListInfo
  // trusted entity that matched the certificate chain
  entity: TrustedEntity
  // certificate that matched the trust list
  cert: CertificateInfoExtended
}

let globalTrustLists: TrustList[] = []

// Hosts permitted to serve auto-refreshed trust lists (#124). A custom list's
// download_url is only re-fetched if its host is on (or a subdomain of) this set.
const ALLOWED_REFRESH_HOSTS = ['contentcredentials.org', 'c2pa.org', 'trusteddit.com', 'verifieddit.com']

function isAllowedRefreshHost (urlString: string): boolean {
  let host: string
  try {
    host = new URL(urlString).hostname.toLowerCase()
  } catch {
    return false
  }
  return ALLOWED_REFRESH_HOSTS.some((h) => host === h || host.endsWith('.' + h))
}

/**
 * Structural validation of untrusted trust-list JSON before it is accepted into
 * the trust store (#124). Rejects malformed shapes before they reach the x509
 * parser via processDownloadedTrustList.
 */
export function validateTrustListShape (tl: unknown): tl is TrustList {
  if (typeof tl !== 'object' || tl === null) return false
  const t = tl as Record<string, unknown>
  if (typeof t.description !== 'string') return false
  if (!Array.isArray(t.entities)) return false
  for (const e of t.entities) {
    if (typeof e !== 'object' || e === null) return false
    const ent = e as Record<string, unknown>
    if (typeof ent.name !== 'string' || typeof ent.isCA !== 'boolean') return false
    const jwks = ent.jwks as Record<string, unknown> | undefined
    if (jwks == null || !Array.isArray(jwks.keys)) return false
  }
  return true
}

const getInfoFromTrustList = (tl: TrustList): TrustListInfo => {
  const tli: TrustListInfo = {
    description: tl.description,
    download_url: tl.download_url,
    website: tl.website,
    last_updated: tl.last_updated,
    entities_count: tl.entities.length
  }
  if (tl.version != null) {
    tli.version = tl.version
  }
  if (tl.name != null) {
    tli.name = tl.name
  }
  if (tl.logo_icon != null) {
    tli.logo_icon = tl.logo_icon
  }
  return tli
}

/**
 * Retrieves the trust list infos.
 * @returns The trust list infos if available, otherwise undefined.
 */
export async function getTrustListInfos (): Promise<TrustListInfo[]> {
  if (globalTrustLists != null && globalTrustLists.length > 0) {
    return await Promise.resolve(globalTrustLists.map(tl => getInfoFromTrustList(tl)))
  } else {
    return await Promise.resolve([])
  }
}

/**
 * Process a downloaded trust list before storing it
 */
async function processDownloadedTrustList (tl: TrustList): Promise<void> {
  // make sure each certificate has a thumbprint, if not, calculate it
  for (const entity of tl.entities) {
    for (const jwk of entity.jwks.keys) {
      if ((jwk['x5t#S256'] == null) && (jwk.x5c != null) && jwk.x5c.length > 0) {
        // calculate the thumbprint of the first cert in the chain
        try {
          jwk['x5t#S256'] = await calculateSha256CertThumbprintFromX5c(jwk.x5c[0])
        } catch (error) {
          // log the error, ignore the cert
        }
      }
    }
  }
}

/**
 * Returns the JWK key type `kty` corresponding to a supported signature alg
 */
function sigAlgToKeyType (sigAlg: string): ValidKeyTypes {
  const sigAlgLC = sigAlg.toLowerCase().replace('-', '')
  if (sigAlgLC === 'sha256withrsaencryption' || sigAlgLC === 'sha384withrsaencryption' || sigAlgLC === 'sha512withrsaencryption' || sigAlgLC === 'idrsassapss') {
    return 'RSA'
  } else if (sigAlgLC === 'ecdsawithsha256' || sigAlgLC === 'ecdsawithsha384' || sigAlgLC === 'ecdsawithsha512') {
    return 'EC'
  } else if (sigAlgLC === 'ided25519') {
    return 'OKP'
  } else {
    throw new Error(`Unsupported C2PA sig alg: ${sigAlg}`)
  }
}

/**
 * Stores the updated trust lists and notify the tab of the update
 */
async function storeUpdatedTrustLists (message?: string): Promise<void> {
  await chrome.storage.local.set({ trustList: globalTrustLists })
  void notifyTabsOfTrustListUpdate()
}

/**
 * Adds a trust anchor to the built-in trust anchors list, returns the corresponding trust list info or throws an error
 */
export async function addTrustAnchor (pemCert: string, tsa = false): Promise<void> {
  if (pemCert == null || typeof pemCert !== 'string') {
    throw new Error('Invalid trust anchor')
  }

  const derCert = PEMtoDER(pemCert)
  const cert = await certificateFromDer(derCert)
  const x5c = bytesToBase64(derCert)

  // create an entity to add to the built-in trust anchor list
  const DN = distinguishedNameToString(cert.subject)
  const kty = sigAlgToKeyType(cert.signatureAlgorithm)
  const entity: TrustedEntity = {
    name: DN,
    display_name: DN,
    contact: '', // n/a
    isCA: true,
    jwks: {
      keys: [
        {
          kty,
          x5c: [
            x5c
          ],
          'x5t#S256': cert.sha256Thumbprint
        }
      ]
    }
  }

  // find the local trust anchor list
  const listName = tsa ? LOCAL_TRUST_TSA_LIST_NAME : LOCAL_TRUST_ANCHOR_LIST_NAME
  const anchorTL = globalTrustLists.find(tl => tl.name === listName)
  if (anchorTL == null) {
    // list doesn't exist; create it
    const tl: TrustList = {
      name: listName,
      description: listName,
      download_url: '', // n/a
      website: '', // n/a
      last_updated: '', // unused for non-downloadable trust lists
      entities: [entity]
    }
    globalTrustLists.push(tl)
  } else {
    // add the entity to the list
    // add or replace the entity in the list
    const existingEntity = anchorTL.entities.find(e => e.name === entity.name)
    if (existingEntity != null) {
      const index = anchorTL.entities.indexOf(existingEntity)
      anchorTL.entities[index] = entity
    } else {
      anchorTL?.entities.push(entity)
    }
    // update the global trust list
    const index = globalTrustLists.indexOf(anchorTL)
    globalTrustLists[index] = anchorTL
  }

  await storeUpdatedTrustLists(`Trust anchor added to the ${listName} list: ${entity.name}`)
}

/**
 * Adds a trust list, returns the corresponding trust list info or throws an error
 */
export async function addTrustList (tl: TrustList): Promise<void> {

  // #124: validate the structure of an imported (untrusted) trust list before
  // it reaches the x509 parser, rather than the previous `typeof tl` no-op.
  if (!validateTrustListShape(tl)) {
    throw new Error('Invalid trust list')
  }

  await processDownloadedTrustList(tl)

  // set the global trust list
  globalTrustLists.push(tl)

  void storeUpdatedTrustLists(`Trust list stored: ${tl.name}`)
}

/**
 * Adds a trust file, either a trust list or a single certificate
 * @param content file content
 */
export async function addTrustFile (content: string): Promise<void> {
  if (content.startsWith('{')) {
    const json = JSON.parse(content) as TrustList
    await addTrustList(json)
  } else {
    await addTrustAnchor(content)
  }
}

/**
 * Adds a TSA trust file, either a trust list or a single certificate
 * @param content file content
 */
export async function addTSATrustFile (content: string): Promise<void> {
  await addTrustAnchor(content, true)
}

/**
 * Removes a trust list from the trust list array.
 * @param index index of the trust list to remove
 */
export async function removeTrustList (index: number): Promise<void> {

  const name = globalTrustLists[index].name

  // remove the trust list
  globalTrustLists.splice(index, 1)

  await storeUpdatedTrustLists(`Trust list removed, index: ${index}, name: ${name}`)
}

/**
 * Retrieves the trust lists from storage.
 */
export async function loadTrustLists (): Promise<void> {
  // load the trust lists from storage
  const trustListStore = await chrome.storage.local.get('trustList') as { trustList: TrustList[] }
  const storedTrustList = trustListStore.trustList
  if (storedTrustList != null) {
    globalTrustLists = storedTrustList
  } else {
  }
}

/**
 * Checks if a certificate chain is included in a trust list (either the leaf certificate or one of the CA anchors)
 * @param certChain a certificate chain
 * @returns a trust list match object if found, otherwise null
 */
/**
 * Build the signature-VERIFIED certificate path starting from the signing leaf
 * (certChain[0]) and walking upward: at each step we look for a cert in the
 * supplied chain that *actually signed* the current cert (real signature check,
 * not DN/thumbprint matching). A cert merely present in the array but which did
 * not sign anything on the path is never added.
 *
 * This is the heart of the trust-spoof fix (issue #112): an attacker can paste
 * a trusted CA cert into the COSE x5chain, but it will not appear on the
 * verified path because it did not sign the attacker's leaf.
 */
async function buildVerifiedPath (certChain: CertificateInfoExtended[]): Promise<CertificateInfoExtended[]> {
  const leaf = certChain[0]
  const path: CertificateInfoExtended[] = [leaf]
  const used = new Set<string>([leaf.sha256Thumbprint])
  let current = leaf
  // Bounded by the chain length; each iteration adds at most one cert.
  for (let i = 0; i < certChain.length; i++) {
    let next: CertificateInfoExtended | null = null
    for (const candidate of certChain) {
      if (used.has(candidate.sha256Thumbprint)) continue
      if (candidate.der != null && current.der != null && await verifyParentSignedChild(candidate.der, current.der)) {
        next = candidate
        break
      }
    }
    if (next == null) break
    path.push(next)
    used.add(next.sha256Thumbprint)
    current = next
  }
  return path
}

/**
 * Match a single certificate against the trust lists by SHA-256 thumbprint and
 * CA flag.
 */
function matchCertToTrustLists (cert: CertificateInfoExtended, trustLists: TrustList[]): TrustListMatch | null {
  for (const trustList of trustLists) {
    for (const entity of trustList.entities) {
      for (const jwkCert of entity.jwks.keys) {
        if ((jwkCert['x5t#S256'] != null) && jwkCert['x5t#S256'].toLowerCase() === cert.sha256Thumbprint && entity.isCA === cert.isCA) {
          return { tlInfo: getInfoFromTrustList(trustList), entity, cert }
        }
      }
    }
  }
  return null
}

/**
 * Checks whether the signing certificate chains, via a signature-VERIFIED path,
 * to a trusted anchor. Replaces the previous "any thumbprint present in the
 * chain" logic, which trusted a cert merely co-located in an attacker-supplied
 * array (issue #112, CRITICAL-1).
 *
 * Trust is granted only when EITHER:
 *  (a) a trusted entity sits on the verified path from the leaf, OR
 *  (b) a trusted CA anchor we hold actually signed the top of the verified path
 *      (covers chains that omit the root and embed only leaf+intermediates).
 */
export async function checkTrustListInclusion (certChain: CertificateInfoExtended[], trustLists: TrustList[] = globalTrustLists): Promise<TrustListMatch | null> {
  if (certChain == null || certChain.length === 0) return null
  if (trustLists == null || trustLists.length === 0) return null

  // 1. Verified path from the signing leaf upward.
  const path = await buildVerifiedPath(certChain)

  // 2. A trusted entity that sits ON the verified path (leaf or any verified CA).
  for (const cert of path) {
    const match = matchCertToTrustLists(cert, trustLists)
    if (match != null) return match
  }

  // 3. A trusted CA anchor we hold that actually signed the top of the path,
  //    even if that anchor was not embedded in the chain.
  const top = path[path.length - 1]
  if (top.der != null) {
    for (const trustList of trustLists) {
      for (const entity of trustList.entities) {
        if (!entity.isCA) continue
        for (const jwk of entity.jwks.keys) {
          const anchorDer = jwk.x5c?.[0]
          if (anchorDer != null && await verifyParentSignedChild(anchorDer, top.der)) {
            return { tlInfo: getInfoFromTrustList(trustList), entity, cert: top }
          }
        }
      }
    }
  }

  return null
}

/**
 * Checks if a certificate chain is included in the TSA trust list (either the leaf certificate or one of the CA anchors)
 * @param certChain a certificate chain
 * @returns a trust list match object if found, otherwise null
 */
export async function checkTSATrustListInclusion (certChain: CertificateInfoExtended[]): Promise<TrustListMatch | null> {
  return await checkTrustListInclusion(certChain, globalTrustLists.filter(tl => tl.name === LOCAL_TRUST_TSA_LIST_NAME))
}

// update the trust lists if they are outdated
export async function refreshTrustLists (): Promise<void> {
  let trustListsUpdated = false
  if (globalTrustLists != null && globalTrustLists.length > 0) {
    const fetchPromises = globalTrustLists.map(async (trustList, index) => {
      if (trustList.download_url !== '') {
        // #124: only refresh from an allowlisted host, with credentials omitted.
        if (!isAllowedRefreshHost(trustList.download_url)) {
          throw new Error(`Trust list refresh for ${trustList.name}: host not allowlisted`)
        }
        const response = await fetch(trustList.download_url, { credentials: 'omit' })
        // Guard against captive portals / 5xx returning HTML 200; without this
        // the next .json() throws and the outer catch silently keeps the user
        // on a stale trust list (security degradation invisible to user).
        if (!response.ok) {
          throw new Error(`Trust list refresh failed for ${trustList.name}: HTTP ${response.status}`)
        }
        const raw: unknown = await response.json()
        // #124: validate the untrusted shape before it reaches the x509 parser.
        if (!validateTrustListShape(raw)) {
          throw new Error(`Trust list refresh for ${trustList.name}: malformed schema`)
        }
        const freshTrustList = raw
        if (freshTrustList.last_updated > trustList.last_updated) {
          await processDownloadedTrustList(freshTrustList)
          globalTrustLists[index] = freshTrustList
          trustListsUpdated = true
        }
      } else {
        await Promise.resolve()
      }
    })

    await Promise.all(fetchPromises)

    if (trustListsUpdated) {
      await storeUpdatedTrustLists('Trust lists refreshed')
    }
  }
}

async function notifyTabsOfTrustListUpdate (): Promise<void> {
  void sendMessageToAllTabs({ action: MSG_TRUSTLIST_UPDATE, data: null })
}

/*
 *  Initialize the trust list module and message listeners
 *  Other modules import functions from this module, but they don't want the listeners
 *  So the init function needs to be called explicitly
 */
/*
 * Stable identity for a trust list: the anchors it actually carries.
 *
 * Names cannot serve as the key — the official and Trusteddit TSA lists are
 * both deliberately called 'Local TSA Anchors' so checkTSATrustListInclusion
 * finds them — and download_url is empty on every bundled list. The thumbprint
 * set is version-independent, so a list stored by an older build still matches
 * the bundled list it came from.
 */
function trustListKey (tl: TrustList): string {
  // Total by construction. This runs over whatever chrome.storage.local holds,
  // which may predate any current schema, so a missing entities/jwks/keys must
  // yield a key rather than throw. See the per-entry guard in
  // mergeDefaultTrustLists for why a throw here is a fail-OPEN.
  const thumbprints = (tl.entities ?? [])
    .flatMap((entity) => entity?.jwks?.keys?.map((jwk) => jwk['x5t#S256']) ?? [])
    .filter((thumbprint): thumbprint is string => thumbprint != null && thumbprint !== '')
    .sort()
  return `${tl.name ?? ''}|${thumbprints.join(',')}`
}

/*
 * Reconciles the bundled trust anchors into whatever is already stored.
 *
 * chrome.storage.local survives extension updates, so this MUST merge rather
 * than load-once-when-empty. It used to only run on an empty store, which meant
 * any anchor added after a user's first install was shipped in the bundle but
 * never loaded: the Trusteddit anchors arrived in v1.2.0, so every profile
 * created on v1.1.3 or earlier kept showing trusteddit.com-signed media as
 * untrusted while a fresh install looked perfect.
 *
 * User-added anchors are preserved; only bundled lists are reconciled.
 */
async function mergeDefaultTrustLists (): Promise<void> {
  let defaultLoaded = 0
  let lastError: unknown = null
  let changed = false

  // The demo-corpus fixture CA is NOT a C2PA anchor — it is a key we generated.
  // Loading it in a shipped build means anyone holding that key can mint media
  // that every user sees as trusted, which is precisely the claim this product
  // exists to make honestly. Dev and E2E builds keep it so the bundled corpus
  // still exercises the trusted path; the store artifact must not.
  const bundled: TrustList[] = [
    defaultTestTrustList as TrustList,
    defaultTsaTrustList as TrustList,
    caiKnownAnchors as TrustList,
    ...(TRUST_DEV_FIXTURES ? [devTrustList as TrustList] : []),
    defaultAiTrustList as TrustList,
    trustedditTrustList as TrustList,
    // Named 'Local TSA Anchors' so checkTSATrustListInclusion picks it up.
    trustedditTsaTrustList as TrustList
  ]

  // Built one entry at a time on purpose. This is the first statement that
  // touches stored data, and it used to be an unguarded .map(): a single
  // malformed record threw here, before the merge loop and before the fixture
  // eviction below, so init() caught it and BOTH halves of the #155 fix were
  // skipped. That failure is fail-open (the public demo-corpus CA stays
  // trusted and newly bundled anchors never arrive), which is the opposite of
  // what a trust store should do when it cannot read itself.
  const stored = new Set<string>()
  for (const tl of globalTrustLists) {
    try {
      stored.add(trustListKey(tl))
    } catch (error) {
      lastError = error
    }
  }

  for (const trustList of bundled) {
    try {
      await processDownloadedTrustList(trustList)
      defaultLoaded += 1
      if (!stored.has(trustListKey(trustList))) {
        globalTrustLists.push(trustList)
        stored.add(trustListKey(trustList))
        changed = true
      }
    } catch (error) {
      lastError = error
    }
  }

  // A profile that once ran a dev or E2E build has the fixture CA persisted.
  // Storage outlives the build flag, so a production build must evict it —
  // otherwise the public fixture key stays trusted for that user forever.
  if (!TRUST_DEV_FIXTURES) {
    try {
      await processDownloadedTrustList(devTrustList as TrustList)
      const fixtureKey = trustListKey(devTrustList as TrustList)
      const kept = globalTrustLists.filter((tl) => trustListKey(tl) !== fixtureKey)
      if (kept.length !== globalTrustLists.length) {
        globalTrustLists.splice(0, globalTrustLists.length, ...kept)
        changed = true
      }
    } catch (error) {
      lastError = error
    }
  }

  // If every default list fails to load, every signed image renders untrusted
  // and the user has no idea why. Throw so init() can surface it instead of
  // silently persisting an empty trust list.
  if (defaultLoaded === 0) {
    const msg = lastError instanceof Error ? lastError.message : String(lastError)
    throw new Error(`No default trust lists loaded: ${msg}`)
  }

  // Only write when the set actually moved: init() runs on every service worker
  // wake-up, and a write notifies every open tab to re-render.
  if (changed) {
    await storeUpdatedTrustLists('Default trust lists loaded.')
  }
}

export async function init (): Promise<void> {
  await loadTrustLists(); // Attempt to load existing trust lists first
  try {
    await mergeDefaultTrustLists();
    // Clear any prior error so the popup banner reflects current state.
    void chrome.storage.session?.remove('trustListsInitError')
  } catch (error) {
    // Surface the failure via chrome.storage.session so the popup can
    // render a banner, but keep init alive so the message handlers
    // below still register. A SW that cannot answer GET_TRUSTLIST_INFOS
    // is worse than one that answers with the explicit error state.
    const message = error instanceof Error ? error.message : String(error)
    void chrome.storage.session?.set({ trustListsInitError: message })
  }

  chrome.runtime.onMessage.addListener(
    // eslint-disable-next-line @typescript-eslint/promise-function-async
    (request: MSG_PAYLOAD, sender, sendResponse) => {
      if (request.action === MSG_GET_TRUSTLIST_INFOS) {
        void getTrustListInfos().then(sendResponse);
        return AWAIT_ASYNC_RESPONSE;
      }
      if (request.action === MSG_ADD_TRUSTLIST) {
        void addTrustList(request.data as TrustList).then(sendResponse);
        return AWAIT_ASYNC_RESPONSE;
      }
      if (request.action === MSG_ADD_TRUSTFILE) {
        void addTrustFile(request.data as string).then(sendResponse);
        return AWAIT_ASYNC_RESPONSE;
      }
      if (request.action === MSG_ADD_TSA_TRUSTFILE) {
        void addTSATrustFile(request.data as string).then(sendResponse);
        return AWAIT_ASYNC_RESPONSE;
      }
      if (request.action === MSG_REMOVE_TRUSTLIST) {
        void removeTrustList(request.data as number).then(sendResponse);
        return AWAIT_ASYNC_RESPONSE;
      }
    }
  );
}
