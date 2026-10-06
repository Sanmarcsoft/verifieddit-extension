# Durable video fixtures (#195)

- `pattern-no-credentials.mp4`: a two-second ffmpeg test pattern
  (`testsrc2`, 320x240). It carries no Content Credentials.
- `pattern.registered.c2pa`: the credential the Trusteddit **testing** signer
  issued for that clip (default profile, testing certificate chain, no claim
  about how the picture was made). It stands in for what the registry returns
  for a recovered video: the credential alone, never the video.

Used by `test/e2e/recover-video.spec.ts`.
