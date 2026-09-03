/*
 *  Copyright (c) Microsoft Corporation.
 *  Licensed under the MIT license.
 */

import { Certificate, type DistinguishedName as x509DistinguishedName } from '@fidm/x509'
import { Buffer } from 'buffer' // required for polyfill
import { bytesToHex } from '../utils.js'

export interface COSE {
  0: Uint8Array
  1: { x5chain?: Uint8Array[], sigTst?: { tstTokens: Array<{ val: Uint8Array }> } }
  2: null
  3: Uint8Array
}

export interface DistinguishedName {
  CN: string
  C: string
  O: string
  OU: string
  L: string
  ST: string
}

export type isoDateString = string

export interface CertificateInfo {
  issuer: DistinguishedName
  subject: DistinguishedName
  validFrom: isoDateString
  validTo: isoDateString
  isCA: boolean
}

export interface CertificateInfoExtended extends CertificateInfo {
  sha256Thumbprint: string
  signatureAlgorithm: string
  // Base64 DER of the certificate, retained so the trust layer can rebuild a
  // Certificate object and verify chain-path signatures (not just thumbprints).
  // Survives structured-clone messaging where Certificate objects would not.
  der: string
}

export async function calculateSha256CertThumbprintFromDer (der: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest({ name: 'SHA-256' }, der)
  const hex = bytesToHex(new Uint8Array(digest))
  return hex
}

export async function calculateSha256CertThumbprintFromX5c (x5c: string): Promise<string> {
  return await calculateSha256CertThumbprintFromDer(Buffer.from(x5c, 'base64'))
}

export async function certificateFromDer (der: Uint8Array): Promise<CertificateInfoExtended> {
  const sha256Thumbprint = await calculateSha256CertThumbprintFromDer(der)
  const pem = DERtoPEM(der)
  const cert = Certificate.fromPEM(Buffer.from(pem, 'utf-8'))

  const certInfo = parseCertificate(cert)

  const certInfoEx = certInfo as CertificateInfoExtended
  certInfoEx.sha256Thumbprint = sha256Thumbprint
  certInfoEx.signatureAlgorithm = cert.signatureAlgorithm
  certInfoEx.der = Buffer.from(der).toString('base64')

  return certInfoEx
}

/**
 * Rebuild an @fidm/x509 Certificate from a base64-DER string. Returns null on
 * any parse error (treated as "cannot verify" by callers — fail closed).
 */
export function certObjectFromDerBase64 (der: string): Certificate | null {
  try {
    const derBytes = Buffer.from(der, 'base64')
    return Certificate.fromPEM(Buffer.from(DERtoPEM(derBytes), 'utf-8'))
  } catch {
    return null
  }
}

// Signature-algorithm OID → WebCrypto verify parameters.
const SIG_OID_TO_WEBCRYPTO: Record<string, { name: 'ECDSA' | 'RSASSA-PKCS1-v1_5', hash: string }> = {
  '1.2.840.10045.4.3.2': { name: 'ECDSA', hash: 'SHA-256' }, // ecdsa-with-SHA256
  '1.2.840.10045.4.3.3': { name: 'ECDSA', hash: 'SHA-384' }, // ecdsa-with-SHA384
  '1.2.840.10045.4.3.4': { name: 'ECDSA', hash: 'SHA-512' }, // ecdsa-with-SHA512
  '1.2.840.113549.1.1.11': { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
  '1.2.840.113549.1.1.12': { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-384' },
  '1.2.840.113549.1.1.13': { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-512' }
}

// EC named-curve OID (DER value bytes) → WebCrypto curve + coordinate byte size.
const EC_CURVES: Array<{ bytes: number[], curve: string, size: number }> = [
  { bytes: [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07], curve: 'P-256', size: 32 }, // prime256v1
  { bytes: [0x2b, 0x81, 0x04, 0x00, 0x22], curve: 'P-384', size: 48 }, // secp384r1
  { bytes: [0x2b, 0x81, 0x04, 0x00, 0x23], curve: 'P-521', size: 66 } // secp521r1
]

function findEcCurve (spki: Uint8Array): { curve: string, size: number } | null {
  for (const c of EC_CURVES) {
    for (let i = 0; i + c.bytes.length <= spki.length; i++) {
      let hit = true
      for (let j = 0; j < c.bytes.length; j++) {
        if (spki[i + j] !== c.bytes[j]) { hit = false; break }
      }
      if (hit) return { curve: c.curve, size: c.size }
    }
  }
  return null
}

// DER ECDSA-Sig-Value (SEQUENCE { INTEGER r, INTEGER s }) → fixed-width r‖s
// (IEEE P1363), which is the form WebCrypto's ECDSA verify expects.
function derEcdsaToRaw (der: Uint8Array, size: number): Uint8Array | null {
  if (der[0] !== 0x30) return null
  let i = 2
  if ((der[1] & 0x80) !== 0) i = 2 + (der[1] & 0x7f) // long-form SEQUENCE length
  if (der[i] !== 0x02) return null
  const rLen = der[i + 1]
  let r = der.subarray(i + 2, i + 2 + rLen)
  i = i + 2 + rLen
  if (der[i] !== 0x02) return null
  const sLen = der[i + 1]
  let s = der.subarray(i + 2, i + 2 + sLen)
  const trimLeadingZeros = (b: Uint8Array): Uint8Array => {
    let k = 0
    while (k < b.length - 1 && b[k] === 0) k++
    return b.subarray(k)
  }
  r = trimLeadingZeros(r)
  s = trimLeadingZeros(s)
  if (r.length > size || s.length > size) return null
  const out = new Uint8Array(size * 2)
  out.set(r, size - r.length)
  out.set(s, size * 2 - s.length)
  return out
}

function publicKeySpkiDer (cert: Certificate): Uint8Array {
  // @fidm's PublicKey.toPEM() emits an SPKI "PUBLIC KEY" block. Strip any PEM
  // armour (not just CERTIFICATE, which PEMtoDER assumes) and decode.
  const b64 = cert.publicKey.toPEM().replace(/-----[A-Z0-9 ]+-----/g, '').replace(/\s+/g, '')
  return new Uint8Array(Buffer.from(b64, 'base64'))
}

/**
 * True iff `parent` actually signed `child` (real signature verification, not
 * a DN/thumbprint heuristic). Both args are base64-DER. Fails closed on any
 * error. This is the primitive that closes the trust-badge spoof: a cert that
 * is merely present in an attacker-controlled chain array does NOT verify a
 * leaf it did not sign (issue #112).
 *
 * Verification uses WebCrypto (`crypto.subtle.verify`), NOT @fidm's
 * `checkSignature`. @fidm verifies via Node's `crypto.createVerify`, which is
 * absent in the extension's browser/service-worker/offscreen runtimes (the
 * rollup node-crypto polyfill cannot verify ECDSA P-384). That silently made
 * every chain fail to verify in-browser, so every signed asset rendered
 * "not in trust list" even when its CA was bundled (#137). WebCrypto is native
 * in all of those contexts (and in bun), and supports ECDSA P-256/384/521 and
 * RSA. The @fidm parse is still used for the CA / issuer guards below.
 */
export async function verifyParentSignedChild (parentDer: string, childDer: string): Promise<boolean> {
  try {
    const parent = certObjectFromDerBase64(parentDer)
    const child = certObjectFromDerBase64(childDer)
    if (parent == null || child == null) return false

    // Preserve the #112 security guards before spending a crypto verify: the
    // parent must be a CA permitted to sign certs, and must actually be the
    // child's issuer (DN match). Mirrors @fidm checkSignature's preconditions.
    if (parent.version === 3 && (!parent.basicConstraintsValid || !parent.isCA)) return false
    if (parent.getExtension('keyUsage', 'keyCertSign') !== true) return false
    // NOTE: @fidm's child.isIssuer(parent) is deliberately NOT used. It hashes
    // the DN via Node's crypto.createHash, which the browser/SW crypto polyfill
    // does not implement (TypeError: createHash is not a function) — the very
    // bug that made all trust checks fail. The WebCrypto signature verification
    // below is the authoritative proof that `parent` signed `child`; a DN-match
    // prefilter is a redundant optimisation, not a security requirement.

    const alg = SIG_OID_TO_WEBCRYPTO[child.signatureOID]
    if (alg == null) return false

    const spki = publicKeySpkiDer(parent)
    const tbs = child.tbsCertificate.DER as Uint8Array

    if (alg.name === 'ECDSA') {
      const ec = findEcCurve(spki)
      if (ec == null) return false
      const key = await crypto.subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve: ec.curve }, false, ['verify'])
      const sig = derEcdsaToRaw(child.signature as Uint8Array, ec.size)
      if (sig == null) return false
      return await crypto.subtle.verify({ name: 'ECDSA', hash: alg.hash }, key, sig, tbs)
    }

    const key = await crypto.subtle.importKey('spki', spki, { name: 'RSASSA-PKCS1-v1_5', hash: alg.hash }, false, ['verify'])
    return await crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, key, child.signature as Uint8Array, tbs)
  } catch {
    return false
  }
}

/**
 * Converts a DER encoded certificate to a PEM encoded certificate.
 */
export function DERtoPEM (der: Uint8Array): string {
  const PEM_HEADER = '-----BEGIN CERTIFICATE-----\n'
  const PEM_FOOTER = '\n-----END CERTIFICATE-----'
  const base64String = Buffer.from(der).toString('base64')
  const formattedBase64 = base64String.match(/.{1,64}/g)?.join('\n')
  return PEM_HEADER + formattedBase64 + PEM_FOOTER
}

/**
 * Converts a PEM encoded certificate to a DER encoded certificate.
 */
export function PEMtoDER (pem: string): Uint8Array {
  const base64String = pem.replace(/-----BEGIN CERTIFICATE-----/, '').replace(/-----END CERTIFICATE-----/, '').replace(/\r?\n|\r/g, '')
  return Buffer.from(base64String, 'base64')
}

/*
  The x509 lib uses getters to return cert properties that are stripped during serialization.
  This function extracts the properties that are needed for display
*/
function parseCertificate (cert: Certificate): CertificateInfo {
  return {
    issuer: getDistinguishedName(cert.issuer),
    subject: getDistinguishedName(cert.subject),
    validFrom: localDateTime(cert.validFrom.toString()),
    validTo: localDateTime(cert.validTo.toString()),
    isCA: cert.isCA
  }
}

function getDistinguishedName (dn: x509DistinguishedName): DistinguishedName {
  const getShortName = (shortName: string): string => {
    const attr = dn.attributes.find((attr) => attr.shortName === shortName)
    return attr?.value ?? ''
  }
  return {
    CN: getShortName('CN'),
    O: getShortName('O'),
    OU: getShortName('OU'),
    C: getShortName('C'),
    L: getShortName('L'),
    ST: getShortName('ST')
  }
}

export function distinguishedNameToString (dn: DistinguishedName): string {
  // combine the non-empty DN fields
  return [dn.CN, dn.O, dn.OU, dn.C, dn.L, dn.ST].filter((field) => field != null && field.length > 0).join(', ')
}

export function localDateTime (isoDateString: string): string {
  const date = new Date(isoDateString)
  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    // hour: 'numeric',
    // minute: 'numeric',
    // second: 'numeric',
    // timeZoneName: 'short',
    hour12: true
  }
  const formattedDate = new Intl.DateTimeFormat('en-US', options).format(date)
  return formattedDate
}
