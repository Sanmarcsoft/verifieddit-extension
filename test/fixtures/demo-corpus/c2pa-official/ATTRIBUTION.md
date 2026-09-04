# C2PA official public test files

Source: https://github.com/c2pa-org/public-testfiles
Licence: CC-BY-SA-4.0 (see https://creativecommons.org/licenses/by-sa/4.0/)
Vendored from `legacy/1.4/` at branch `main`, 2026-09-01: 26 JPEG, 1 MP4, 1 PDF.

Files are byte-identical to upstream; sizes verified against the upstream git tree.

## Why `legacy/1.4/` and not `2.2/`

The `2.2/` tree in that repository currently contains no test files. Every path under
`2.2/{image,audio,video,font,pdf}/{good,bad}/` is either a `README.md` or a zero-byte
`.gitkeep`. `2.2/image/README.md` is a catalogue whose asset links resolve to
`https://spec.c2pa.org/public-testfiles/image/jpeg/...`, which returns 404. The only
test binaries the repository actually holds are under `legacy/1.4/`.

Re-check `2.2/` before each corpus refresh; when C2PA populates it, migrate.

## What upstream does not have

There is no audio, PNG, WebP or DNG test file anywhere in the repository. Every such path
is a zero-byte `.gitkeep`, in both `2.2/` and `legacy/1.4/`. The complete set of real media
upstream holds is: 26 JPEG, 1 MP4, 1 PDF, 1 TTF.

PNG and WebP coverage therefore still comes only from `test/fixtures/demo-corpus`
(`02-greentrust-png.png`, `03-greentrust-webp.webp`). There is no audio fixture available
from this source at all.

## Trust expectations

Upstream states, in `2.2/image/README.md`:

> Content Credentials for the assets from Adobe were added using C2PA Tool's test
> certificate, which is not on the Verify tool's temporary known certificate list.

So every signed file here is expected to render as an UNTRUSTED signer in a production
build of this extension, exactly as it does in Adobe's Verify. That is the correct result,
not a regression. This set exists for negative and error-path coverage.

It deliberately does NOT replace `test/fixtures/demo-corpus`, which still holds the only
assets that exercise the trusted path (`08-trusted-trusteddit-signed.jpg`: trusted signer,
RFC 3161 timestamp, durable soft binding).

## Expected verdict per file

| File | Expectation |
|---|---|
| adobe-20220124-A.jpg | no Content Credentials |
| adobe-20220124-I.jpg | no Content Credentials |
| adobe-20220124-C.jpg | valid claim, untrusted signer |
| adobe-20220124-CA.jpg | valid, one ingredient, untrusted signer |
| adobe-20220124-CACA.jpg | valid, untrusted signer |
| adobe-20220124-CAI.jpg | valid, two ingredients, untrusted signer |
| adobe-20220124-CAICA.jpg | valid, two ingredients, untrusted signer |
| adobe-20220124-CAICAI.jpg | valid, two ingredients, untrusted signer |
| adobe-20220124-CI.jpg | valid, one ingredient, untrusted signer |
| adobe-20220124-CICA.jpg | valid, one ingredient, untrusted signer |
| adobe-20220124-CII.jpg | valid, one ingredient, untrusted signer |
| adobe-20220124-XCA.jpg | incomplete: hash mismatch (OTGP) |
| adobe-20220124-XCI.jpg | incomplete: hash mismatch (OTGP) |
| adobe-20220124-E-clm-CAICAI.jpg | invalid: referenced claim missing |
| adobe-20220124-E-dat-CA.jpg | invalid: hard binding hash mismatch |
| adobe-20220124-E-sig-CA.jpg | invalid: signature did not validate |
| adobe-20220124-E-uri-CA.jpg | invalid: assertion URI hash mismatch |
| adobe-20220124-E-uri-CIE-sig-CA.jpg | invalid: bad signature and URI mismatch |
| adobe-20220124-CIE-sig-CA.jpg | invalid signature |
| nikon-20221019-building.jpeg | invalid: claim signature mismatch |
| truepic-20230212-camera.jpg | valid, camera capture with Exif, untrusted signer |
| truepic-20230212-landscape.jpg | valid, camera capture with Exif, untrusted signer |
| truepic-20230212-library.jpg | valid, camera capture with Exif, untrusted signer |
| adobe-20220124-CACAICAICICA.jpg | valid, seven ingredients, untrusted signer |
| adobe-20220124-CAIAIIICAICIICAIICICA.jpg | valid, seven ingredients, untrusted signer |
| adobe-20220124-CICACACA.jpg | valid, one ingredient, untrusted signer |
| video/truepic-20230212-zoetrope.mp4 | valid BMFF C2PA (top-level `uuid` box), untrusted signer |
| pdf/adobe-20240110-single_manifest_store.pdf | single manifest store in PDF |
