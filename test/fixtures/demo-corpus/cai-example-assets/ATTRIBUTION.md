# CAI Example Assets

Source: <https://github.com/contentauth/example-assets> (published at
<https://contentauth.github.io/example-assets/>), the Content Authenticity
Initiative's own reference assets for the CAI documentation.

Licence: **MIT**, Copyright (c) 2025 Content Authenticity Initiative. The full
licence text is vendored here as `LICENSE`.

Retrieved 2026-09-01 from branch `main`. Every file was byte-size verified
against the upstream git tree listing; 14 of 14 matched, 0 mismatches.

## Why this set exists alongside the other two

| Source | Gives us |
|---|---|
| `c2pa-official/` (c2pa-org/public-testfiles) | Breadth of JPEG conformance cases, all signed by the C2PA test certificate |
| `iptc-vmh/` (IPTC Video Metadata Hub) | Video metadata assertion depth |
| **`cai-example-assets/` (this set)** | **Real AI-generated media, real production signers (Adobe, OpenAI), PNG coverage, a durable-watermark asset, and a CAWG identity assertion** |

This is the only one of the three sources that supplies assets signed by
production certificates rather than a test certificate, and the only one with
media that actually carries `trainedAlgorithmicMedia`. That makes it the set
that exercises `src/aiDetection.ts` and `src/durableCredentials.ts` on real
inputs instead of synthetic ones.

It is also the only source providing a PNG. `c2pa-org/public-testfiles` has a
`png/` directory containing nothing but a zero-byte `.gitkeep`.

## Contents

### Images (`images/`)

| File | Bytes | Signer | Embedded JUMBF | AI | Notes |
|---|---|---|---|---|---|
| `ChatGPT_Image.png` | 2,130,441 | OpenAI | yes | **yes** | PNG. `c2pa.opened` with an ingredient chain. Upstream manifest reports `validation_state: Invalid` (see below). |
| `Firefly_tabby_cat.jpg` | 1,047,024 | Adobe Inc. | yes | **yes** | Adobe Firefly. `c2pa.created` + `digitalSourceType: trainedAlgorithmicMedia`. The cleanest AI-image case in the whole corpus. |
| `car-es-Ps-Cr.jpg` | 580,124 | Adobe Inc. | yes | no | Photoshop 26.11.0. Actions: opened, cropped, resized. Valid. |
| `cloudscape-ACA-Cr.jpeg` | 678,062 | Adobe Inc. | yes | no | The richest asset here: signed `c2pa.soft-binding` (`com.adobe.trustmark.P`) plus a second dense-watermark binding, `cawg.identity`, and both `c2pa.training-mining` and `cawg.training-mining` set to `notAllowed`. |
| `crater-lake-cr.jpg` | 618,091 | Adobe Inc. (per sidecar) | **no** | no | Lightroom 8.5.1, schema.org author credit. See the stripped-asset note below. |
| `crater-lake.jpeg` | 730,786 | none | no | no | The unsigned original. Correct negative control. |

### Video (`videos/`)

| File | Bytes | Signer | Embedded JUMBF | AI | Notes |
|---|---|---|---|---|---|
| `sora.MP4` | 5,278,370 | OpenAI | yes | **yes** | `c2pa.created` + `trainedAlgorithmicMedia`, `c2pa.hash.bmff.v3`, RFC 3161 timestamp from DigiCert. Upstream `validation_state: Valid`. |

### Sidecar manifests (`images/manifests/`, `videos/manifests/`)

The upstream `manifests/*.json` files are the CAI's own `c2patool` output for
each asset. They are kept because they are the reference answer: when our
extension disagrees with one of them, exactly one of the two is wrong and the
JSON says what the C2PA reference implementation concluded. They are not inputs
to the extension.

## Two findings that will look like bugs and are not

**1. `crater-lake-cr.jpg` carries no embedded manifest.** A byte scan finds zero
occurrences of `jumb`, `c2pa`, `c2ma` or `caBX`, even though a sidecar manifest
exists for it. The file size matches upstream exactly, so this is not a truncated
download. The extension will correctly report no Content Credentials for it. Do
not file that as a regression. If a durable-recovery path is ever added, this
file becomes the fixture for it, because `crater-lake.jpeg` is the matching
unsigned original.

**2. `ChatGPT_Image.png` is `Invalid` upstream for a reason we may not
reproduce.** Its only failure is `signingCredential.untrusted`. Everything else
passes: claim signature validated, inside validity, every hashed URI matched,
data hash valid. The CAI generated that JSON against the default C2PA trust
list, which does not carry OpenAI. Our build additionally bundles
`src/trust-anchors/ai-trust-list.json`, which contains an `OpenAI` entity. So the
extension may legitimately render this asset as a trusted signer where the
sidecar JSON says untrusted. That is a difference in trust configuration, not a
validation disagreement. Whether the bundled OpenAI key actually matches this
certificate is a question for a probe, not for this document.

## Trust expectations (predicted, to be confirmed by probe)

These are predictions from reading the bundled trust lists, and are recorded
here so that a probe run can contradict them. They are not verification.

- Adobe-signed assets: `src/trust-anchors/default-trust-list.json` carries
  `Adobe Product Issuing CA vault-a-or2.adobe.net cai`, so the three valid Adobe
  assets are expected to resolve as a trusted signer.
- OpenAI-signed assets: `src/trust-anchors/ai-trust-list.json` carries an
  `OpenAI` entity, so `ChatGPT_Image.png` and `sora.MP4` may resolve as trusted
  even though the sidecar JSON reports untrusted.
- `crater-lake.jpeg` and `crater-lake-cr.jpg`: no credentials at all.
- Timestamps: `sora.MP4` is timestamped by
  `DigiCert SHA256 RSA4096 Timestamp Responder 2025 1`, which upstream flagged
  `timeStamp.untrusted` as informational only.

If a probe shows the Adobe assets untrusted, that is a real finding about our
trust store and belongs in an issue, not in a quiet edit to this table.

## Attribution requirement

MIT requires the copyright notice and permission notice be retained. `LICENSE`
in this directory satisfies that. Keep it with the assets.
