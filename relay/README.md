# Signed Telemetry Relay

A lightweight, stateless HTTP relay service written in TypeScript for Bun (`Bun.serve`). The relay receives opt-in, per-install-signed telemetry events from the Verifieddit browser extension, verifies them strictly, and forwards accepted events to a self-hosted Umami instance.

## 1. Running the Relay

### Environment Variables

Configuration is loaded strictly from environment variables without default values for secrets:

| Variable | Required | Description |
|---|---|---|
| `RELAY_TICKET_KEY` | Yes (min 32 bytes) | Secret key used for HMAC-SHA256 install tickets. Placeholder: `replace-with-32-or-more-random-bytes` |
| `UMAMI_URL` | Yes | HTTP or HTTPS URL of the self-hosted Umami instance (e.g. `https://umami.example.com`). |
| `UMAMI_WEBSITE_ID` | Yes | UUID of the target website in Umami. Placeholder: `00000000-0000-0000-0000-000000000000` |
| `PORT` | No (default `3000`) | Listening TCP port number. |
| `RELAY_CLIENT_IP_HEADER` | No | Optional HTTP header name from which client IP address is resolved for rate limiting (e.g. `CF-Connecting-IP`). |

### Client IP Header Configuration

`RELAY_CLIENT_IP_HEADER` allows running the relay behind a trusted reverse proxy (such as Cloudflare or an internal load balancer). When set to a valid HTTP header name (token characters only, no spaces, colons, or commas), the relay extracts the client IP address from that header, trimming surrounding whitespace and taking the first comma-separated entry if a list is supplied. When the header is absent or empty, or when the variable is unset, the relay falls back to the socket peer address.

**Warning**: `RELAY_CLIENT_IP_HEADER` must ONLY be set when the relay is reachable solely through the proxy that sets that header, because otherwise any caller can forge the header and evade or poison the per-address limit.

### Running Locally

To run the relay service directly with Bun:

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

### Run in a Container

The container image can be built using Docker from the repository root:

```bash
# Build context: repository root
docker build -f relay/Dockerfile -t verifieddit-relay .
```

To run the container with environment variables passed via command line flags:

```bash
docker run -d -p 3000:3000 
  -e RELAY_TICKET_KEY=replace-with-32-or-more-random-bytes 
  -e UMAMI_URL=https://umami.example.com 
  -e UMAMI_WEBSITE_ID=00000000-0000-0000-0000-000000000000 
  -e PORT=3000 
  verifieddit-relay
```

Alternatively, supply an environment file (`--env-file`):

```bash
docker run -d -p 3000:3000 --env-file .env.relay verifieddit-relay
```

Note: SanMarcSoft production images are built with Nix (`bin/sovereign-image-build.sh`) and pushed to the Scaleway registry, so this Dockerfile is for local runs and testing, not the production image path.

## 2. Privacy Guarantees

- **No Client IP Storage or Forwarding**: The client IP address is never forwarded to Umami (no `X-Forwarded-For` header), never written to disk, and never logged.
- **Salted Hash Rate Limiting**: The client IP is used solely as an ephemeral in-memory rate-limiter key. The key is a SHA-256 hash combined with a daily rotating random salt (`SHA-256(salt + ":" + ip)`). When the UTC day boundary passes, a new random salt is generated and all existing buckets are dropped. Raw IP addresses are never present in the limiter's memory structures.
- **Stateless Service**: The relay stores nothing per install. Install IDs are RFC 7638 JWK thumbprints computed deterministically from the extension's public key.
- **CORS Restriction**: Cross-Origin Resource Sharing is permitted only for extension origins (`chrome-extension://...` and `moz-extension://...`). All other origins receive no `Access-Control-Allow-Origin` header.

## 3. Rate Limiting and Replay Protection

### Rate Limiting

The relay enforces rate limits across both client IP addresses and install IDs to protect against denial of service, amplification, and ticket harvesting. The limits are configured via constants in `relay/src/limits.ts`:

- `EVENTS_PER_INSTALL_MAX = 120`: maximum events per install ID per minute (`EVENTS_PER_INSTALL_WINDOW_MS = 60 * 1000`).
- `EVENTS_PER_ADDRESS_MAX = 600`: maximum events per client IP address per minute (`EVENTS_PER_ADDRESS_WINDOW_MS = 60 * 1000`).
- `ERASURE_PER_INSTALL_MAX = 5`: maximum erasure requests per install ID per hour (`ERASURE_PER_INSTALL_WINDOW_MS = 60 * 60 * 1000`).
- `ERASURE_PER_ADDRESS_MAX = 30`: maximum erasure requests per client IP address per hour (`ERASURE_PER_ADDRESS_WINDOW_MS = 60 * 60 * 1000`).
- `INSTALLS_PER_ADDRESS_MAX = 30`: maximum install ticket creations per client IP address per minute (`INSTALLS_PER_ADDRESS_WINDOW_MS = 60 * 1000`).

A real install never reaches the event limits under normal usage because the extension throttles auto-scan events to one set per tab per minute, and one user action produces at most a few events.

When a client IP address or install ID exceeds its allowable quota, the request is rejected with `429 Too Many Requests` (`{"error":"rate_limited"}`).

Expired buckets inside `rateLimiter.ts` are swept periodically: within-day sweeps evict expired buckets at most once per window interval, and all buckets are dropped when the salt rotates daily at the UTC midnight boundary.

### Replay Protection

To prevent captured signed requests from being replayed, the relay implements an in-memory replay cache in `relay/src/replayCache.ts`.

- The replay cache keys on the low-s canonical form of the signature (see `relay/src/replayCache.ts`) to avoid signature malleability duplicates.
- Entries expire alongside the 5-minute timestamp validity window (`TIMESTAMP_WINDOW_MS = 5 * 60 * 1000`).
- The cache enforces a hard cap of `MAX_REPLAY_CACHE_ENTRIES = 100000` entries. When full, the oldest entries are evicted first.
- The replay cache is in-memory only and lost on process restart; a restart within five minutes re-opens the window for signatures seen before it.
- A duplicate or replayed request is rejected with `409 Conflict` (`{"error":"replayed_request"}`).

## 4. Endpoints

### `GET /healthz`
Health check endpoint.
- Response: `200 OK` with JSON `{"status":"ok"}`.
- Never returns configuration values or secrets, and does not reveal whether `RELAY_CLIENT_IP_HEADER` is set.

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
    "browser": "chrome",
    "sig": "<ecdsa-p256-sha256-signature-base64url>",
    "jwk": { ... }
  }
  ```
- Validation Requirements:
  1. Ticket HMAC is valid and not expired.
  2. RFC 7638 thumbprint of `jwk` matches `install_id`.
  3. `ts` is within 5 minutes of relay's clock.
  4. `version` is a string up to 32 characters.
  5. `browser` is `"chrome"` or `"firefox"` (taken from extension build, rejected with `400 {"error":"invalid_browser"}` otherwise).
  6. `event.name` is one of the 7 allowed events and `event.params` matches the exact schema with no extra or missing keys.
  7. `sig` is a valid ECDSA P-256 / SHA-256 raw (IEEE P1363, 64 bytes) signature over the canonical JSON of signed fields (`browser`, `event`, `install_id`, `ts`, `version`).
  8. `sig` is not present in the replay cache.
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
        "extension_version": "<version>",
        "browser": "<browser>"
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
    "browser": "chrome",
    "sig": "<ecdsa-signature-base64url>",
    "jwk": { ... }
  }
  ```
- Verified identically to events, with signature calculated over canonical payload `{ action: "erase", browser, install_id, ts }`.
- Response: `200 OK` with JSON `{"ok":true}`.

### Error Responses

The relay produces structured error responses with standard HTTP status codes:

- `400 Bad Request`:
  - `payload_too_large`: request body exceeds 8 KB.
  - `malformed_json`: invalid JSON syntax or incorrect body structure.
  - `invalid_key`: missing, invalid, or non-P-256 public key JWK.
  - `invalid_install_id`: RFC 7638 thumbprint does not match `install_id`.
  - `invalid_ticket`: ticket HMAC verification failed or ticket has expired.
  - `invalid_timestamp`: `ts` timestamp skewed by more than 5 minutes from relay clock.
  - `invalid_version`: version string missing or exceeds 32 characters.
  - `invalid_browser`: browser is neither `"chrome"` nor `"firefox"`.
  - `invalid_event`: unrecognized event name or invalid event parameter schema.
  - `invalid_signature`: ECDSA P-256 signature does not verify over canonical signed payload.
- `404 Not Found`:
  - `not_found`: requested path does not exist.
- `405 Method Not Allowed`:
  - `method_not_allowed`: HTTP method is not permitted for the endpoint.
- `409 Conflict`:
  - `replayed_request`: signature was already recorded in the replay cache within the active window.
- `429 Too Many Requests`:
  - `rate_limited`: client IP address or install ID exceeded the request quota.
- `502 Bad Gateway`:
  - `upstream_failed`: upstream Umami service returned a non-2xx response or timed out.

## 5. Canonical Serialisation & Wire Formats

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
  "browser": "<browser>",
  "event": {
    "name": "<event_name>",
    "params": { ... }
  },
  "install_id": "<install_id>",
  "ts": <timestamp_number>,
  "version": "<version_string>"
}
```
Sorted keys: `browser`, `event`, `install_id`, `ts`, `version`.

#### For Erasure (`canonicaliseErasurePayload`):
The object signed is:
```json
{
  "action": "erase",
  "browser": "<browser>",
  "install_id": "<install_id>",
  "ts": <timestamp_number>
}
```
Sorted keys: `action`, `browser`, `install_id`, `ts`. The `action: "erase"` discriminator prevents event signatures from being replayed as erasure requests.

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

## 6. Erasure Scope Notice

Real deletion of event data inside Umami is out of scope for this service and change. The shipped `InMemoryEraser` appends erasure requests `{ install_id, requested_at }` to an in-memory queue for audit and testing purposes. Production integration with an Umami administrative deletion API or external workflow can be implemented by providing an alternative `Eraser` implementation.
