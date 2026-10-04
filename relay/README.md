# Signed Telemetry Relay

A lightweight, stateless HTTP relay service written in TypeScript for Bun (`Bun.serve`). The relay receives opt-in, per-install-signed telemetry events from the Verifieddit browser extension, verifies them strictly, and forwards accepted events to a self-hosted Umami instance.

## 1. Running the Relay

### Environment Variables

Configuration is loaded strictly from environment variables without default values for secrets:

- `RELAY_TICKET_KEY`: Required string with at least 32 bytes (used for HMAC-SHA256 tickets). Placeholder: `replace-with-32-or-more-random-bytes`
- `UMAMI_URL`: Required HTTP or HTTPS URL of the self-hosted Umami instance (e.g. `https://umami.example.com`).
- `UMAMI_WEBSITE_ID`: Required UUID of the target website in Umami. Placeholder: `00000000-0000-0000-0000-000000000000`
- `PORT`: Optional port number (defaults to `3000`).

### Running

To run the relay service:

```bash
RELAY_TICKET_KEY=replace-with-32-or-more-random-bytes 
UMAMI_URL=https://umami.example.com 
UMAMI_WEBSITE_ID=00000000-0000-0000-0000-000000000000 
PORT=3000 
bun run relay/src/main.ts
```

To run test suites:

```bash
bun test relay
```

## 2. Privacy Guarantees

- **No Client IP Storage or Forwarding**: The client IP address is never forwarded to Umami (no `X-Forwarded-For` header), never written to disk, and never logged.
- **Salted Hash Rate Limiting**: The client IP is used solely as an ephemeral in-memory rate-limiter key. The key is a SHA-256 hash combined with a daily rotating random salt (`SHA-256(salt + ":" + ip)`). When the UTC day boundary passes, a new random salt is generated and all existing buckets are dropped. Raw IP addresses are never present in the limiter's memory structures.
- **Stateless Service**: The relay stores nothing per install. Install IDs are RFC 7638 JWK thumbprints computed deterministically from the extension's public key.
- **CORS Restriction**: Cross-Origin Resource Sharing is permitted only for extension origins (`chrome-extension://...` and `moz-extension://...`). All other origins receive no `Access-Control-Allow-Origin` header.

## 3. Endpoints

### `GET /healthz`
Health check endpoint.
- Response: `200 OK` with JSON `{"status":"ok"}`.
- Never returns configuration values or secrets.

### `POST /v1/installs`
Issues a short-lived ticket and canonical install ID for a client's public key.
- Request Body (max 8 KB):
  ```json
  {
    "jwk": {
      "kty": "EC",
      "crv": "P-256",
      "x": "<base64url-coordinate>",
      "y": "<base64url-coordinate>"
    }
  }
  ```
  Keys with a private key component (`d`), non-EC keys, or curves other than `P-256` are rejected with `400 Bad Request` (`{"error":"invalid_key"}`).
- Response (`200 OK`):
  ```json
  {
    "install_id": "<rfc7638-jwk-thumbprint>",
    "ticket": "<expires_at>.<hmac-sha256-base64url>",
    "expires_at": 1700000600000
  }
  ```
- Rate Limiting: Excess install requests from the same address receive `429 Too Many Requests` (`{"error":"rate_limited"}`).

### `POST /v1/events`
Receives and forwards a signed telemetry event to Umami.
- Request Body (max 8 KB):
  ```json
  {
    "install_id": "<rfc7638-jwk-thumbprint>",
    "ticket": "<ticket-from-installs>",
    "ts": 1700000000000,
    "event": {
      "name": "verify_completed",
      "params": {
        "result": "valid",
        "has_durable_binding": true,
        "media_type": "image"
      }
    },
    "version": "1.3.0",
    "sig": "<ecdsa-p256-sha256-signature-base64url>",
    "jwk": { ... }
  }
  ```
- Validation Requirements:
  1. Ticket HMAC is valid and not expired.
  2. RFC 7638 thumbprint of `jwk` matches `install_id`.
  3. `ts` is within 5 minutes of relay's clock.
  4. `version` is a string up to 32 characters.
  5. `event.name` is one of the 7 allowed events and `event.params` matches the exact schema with no extra or missing keys.
  6. `sig` is a valid ECDSA P-256 / SHA-256 raw (IEEE P1363, 64 bytes) signature over the canonical JSON of signed fields (`event`, `install_id`, `ts`, `version`).
- Upstream Forwarding:
  Accepted events are forwarded to Umami `POST {UMAMI_URL}/api/send` with fixed User-Agent `verifieddit-telemetry-relay/1` and payload:
  ```json
  {
    "type": "event",
    "payload": {
      "website": "<UMAMI_WEBSITE_ID>",
      "hostname": "extension.verifieddit.com",
      "url": "/<event_name>",
      "name": "<event_name>",
      "data": {
        "...params",
        "extension_version": "<version>"
      },
      "id": "<install_id>"
    }
  }
  ```
- Upstream Failures: If Umami responds with a non-2xx status code or times out, the relay returns `502 Bad Gateway` (`{"error":"upstream_failed"}`).

### `DELETE /v1/installs`
Enqueues an install erasure request.
- Request Body (max 8 KB):
  ```json
  {
    "install_id": "<rfc7638-jwk-thumbprint>",
    "ticket": "<ticket>",
    "ts": 1700000000000,
    "sig": "<ecdsa-signature-base64url>",
    "jwk": { ... }
  }
  ```
- Verified identically to events, with signature calculated over `{ action: "erase", install_id, ts }`.
- Response: `200 OK` with JSON `{"ok":true}`.

## 4. Canonical Serialisation & Wire Formats

### RFC 7638 JWK Thumbprint
Calculated over canonical JSON with strictly ordered keys:
`{"crv":"P-256","kty":"EC","x":"<x>","y":"<y>"}`
Hashed using SHA-256 and base64url encoded without padding.

### Deterministic Canonical JSON Algorithm
To generate consistent signatures across client and relay:
1. Primitives (strings, numbers, booleans, null) are JSON-encoded.
2. Arrays preserve element order, with each element recursively canonicalised: `[elem1,elem2]`.
3. Objects have their keys sorted lexicographically (Unicode code point order) and are formatted as `{"key1":val1,"key2":val2}` with no whitespace. Undefined values are omitted.

### Signed Fields

#### For Events (`canonicaliseEventPayload`):
The object signed is:
```json
{
  "event": {
    "name": "<event_name>",
    "params": { ... }
  },
  "install_id": "<install_id>",
  "ts": <timestamp_number>,
  "version": "<version_string>"
}
```
Sorted keys: `event`, `install_id`, `ts`, `version`.

#### For Erasure (`canonicaliseErasurePayload`):
The object signed is:
```json
{
  "action": "erase",
  "install_id": "<install_id>",
  "ts": <timestamp_number>
}
```
Sorted keys: `action`, `install_id`, `ts`. The `action: "erase"` discriminator prevents event signatures from being replayed as erasure requests.

### Ticket Format
Tickets are issued in the format:
`<expires_at_ms>.<hmac_sha256_base64url>`
where HMAC is computed over UTF-8 bytes of `<install_id>:<expires_at_ms>` using `RELAY_TICKET_KEY`.

### Allowed Events and Params Schemas

1. `extension_installed`: `{}`
2. `extension_updated`: `{ "previous_version": string (1-32 chars) }`
3. `verify_started`: `{ "source": "context_menu" | "popup" | "auto_scan" }`
4. `verify_completed`:
   - `result`: `"valid"` | `"invalid"` | `"none"` | `"error"`
   - `has_durable_binding`: `boolean`
   - `media_type`: `"image"` | `"video"` | `"audio"` | `"pdf"`
5. `badge_scan`: `{}`
6. `options_opened`: `{}`
7. `consent_changed`: `{ "value": "granted" | "denied" }`

## 5. Erasure Scope Notice

Real deletion of event data inside Umami is out of scope for this service and change. The shipped `InMemoryEraser` appends erasure requests `{ install_id, requested_at }` to an in-memory queue for audit and testing purposes. Production integration with an Umami administrative deletion API or external workflow can be implemented by providing an alternative `Eraser` implementation.
