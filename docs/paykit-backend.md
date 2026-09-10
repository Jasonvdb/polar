# Paykit local environment (API v1)

The `paykit/` Rust workspace packages a persistent Pubky 0.11.0 StaticTestnet and a receiver supervisor in one network namespace. Each Polar network has its own service, PostgreSQL 18 database, credentials and data. Only the authenticated workbench API is published, on loopback. The Pubky homeserver, auth relay, PKARR relay, DHT and PostgreSQL ports stay inside that network.

Build the ARM64 or AMD64 service image from the `paykit` context:

```sh
docker build -t polar-paykit/service:pr2 -f paykit/Dockerfile paykit
```

The Dockerfile pins multiarchitecture builder/runtime manifests. `Cargo.lock` pins the SDK to `5ef8caf8d9a812f571a954fd3b7afe5ef22fd10f`. It retains `pubky-noise 0.1.0-rc7` from that SDK's committed lockfile: the later rc8 prerelease changes snapshot APIs incompatibly. All builds use `--locked`.

## Configuration and credentials

Electron provisions credentials outside network/export directories. No renderer-supplied path or endpoint is accepted. The service reads these trusted variables:

| Variable                        | Value                                                                  |
| ------------------------------- | ---------------------------------------------------------------------- |
| `PAYKIT_ENVIRONMENT_ID`         | Stable environment UUID                                                |
| `PAYKIT_DATA_DIR`               | Persistent state mount, `/data`                                        |
| `PAYKIT_KEY_FILE`               | `/run/paykit/master-key`, 32 random bytes encoded as 64 hex characters |
| `PAYKIT_TOKEN_FILE`             | `/run/paykit/api-token`, 64 hex characters                             |
| `PAYKIT_POSTGRES_PASSWORD_FILE` | `/run/paykit/postgres-password`, 64 hex characters                     |
| `PAYKIT_POSTGRES_HOST`          | `paykit-postgres`, database and user `pubky`                           |
| `PAYKIT_LISTEN`                 | Optional bind address; default `0.0.0.0:10090` inside container        |

The service creates the database connection string internally for the embedded testnet and removes it before spawning receivers. API tokens, grants, owner keys, Noise keys and decrypted SDK snapshots are never public DTOs or log messages. The local testnet deliberately uses open signup and its documented deterministic test homeserver identity. It must stay in the isolated Docker environment.

## Commands, queries and events

`GET /health` returns `{apiVersion:1,ready}` with 200 or 503. Readiness covers startup/reconciliation and durable application storage; it is not a continuous PostgreSQL probe. Later service outages surface through failed backend operations and receiver errors. All `/v1/*` routes require `Authorization: Bearer TOKEN`.

`POST /v1/commands` accepts `{commandId,command,input}` and durably records the command before returning `202 {operationId}`. Identical retries return the original operation, including after restart. Reusing an ID with different input returns 409. Invalid names, IDs, unknown input fields and unsupported commands are rejected before acceptance.

| Command                                               | Input                                          |
| ----------------------------------------------------- | ---------------------------------------------- |
| `participant.create`                                  | `{name}`                                       |
| `participant.rename`                                  | `{participantId,name}`                         |
| `receiver.create`                                     | `{participantId,name,kind:"wallet"\|"server"}` |
| `receiver.rename`                                     | `{receiverId,name}`                            |
| `receiver.start`, `receiver.stop`, `receiver.restart` | `{receiverId}`                                 |
| `preset.create`                                       | `{}`                                           |

Names are editable; receiver paths and public keys remain stable. Creating a receiver starts its process and publishes and fetches its real public marker. The preset converges to Alice, Bob and Carol with Bob's wallet and server receivers even across partial failures or new command IDs. This increment does not fund wallets or advertise payment support.

`GET /v1/state` returns the public participants, receivers, operations and event sequence. `GET /v1/operations/UUID` exposes queued/running/succeeded/failed, a public result or a sanitized error. Long operations run outside HTTP requests. Callers retain the operation ID if their own wait times out.

`GET /v1/events?after=N` streams persisted events with SSE `id`, event type and `{sequence,type,payload}` data. Sequence numbers persist for the environment lifetime. The log is retained without truncation in this increment. Reconnect with the last processed sequence; deduplicate by sequence. A cursor ahead of this environment returns 409 `event_cursor_reset`; reload `/v1/state` and explicitly reconnect. Renames are observable in state and the operation completion event. HTTP query failures never expose underlying SDK errors.

## Persistence and restart

Application state contains durable command intent, participant identity and receiver desired state. Each receiver has separate encrypted grant/Noise material and a full SDK `StorageState`. XChaCha20-Poly1305 authenticates CBOR snapshots against the environment, receiver and filename. CBOR preserves SDK maps with tuple keys. Transactions use the SDK transaction engine to preserve leases, queue order and monotonic IDs.

Writes use exclusive temporary creation, file fsync, rename and directory fsync. The in-memory state changes only after successful commit. Any failed commit poisons further writes and marks the environment unavailable; even a directory-fsync failure after rename requires reopening and reconciliation. Process locks exclude concurrent supervisors and receiver writers. Corruption and wrong environment/receiver binding fail closed.

Receiver grants are restored through the SDK, validating the client ID, owner and required receiver capabilities. Owner and Noise keys are saved before remote side effects. Restart republishes participant routing into the fresh local DHT, reopens grants, initializes the SDK, publishes each desired receiver marker and fetches it independently before reporting the receiver running. Stopped receivers remain stopped. Receiver processes are reaped independently; service shutdown signals and waits for owned children.

Startup also resumes unregistered participant intents with their saved IDs and owner keys before readiness. This recovers a failed manual signup after a service outage; its original failed operation remains terminal and visible.

Interrupted running **PR2 commands only** are requeued with an explicit `operation.requeued` event and execute using their existing IDs and saved intent. They never become successful merely because the service restarted. A receiver generation can advance again during crash recovery; completed duplicate commands do not restart it again. Future wallet/payment commands must use their own settlement reconciliation and must not inherit this replay policy.

## CLI and diagnostics

The CLI uses the same API and works without Electron:

```sh
export PAYKIT_API_URL=http://127.0.0.1:30090
export PAYKIT_TOKEN_FILE=/absolute/path/to/api-token
polar-paykit state
polar-paykit command preset.create '{}'
polar-paykit operation OPERATION_UUID
```

Commands wait at most 120 seconds and print the operation ID immediately. Poll an existing operation after timeout; do not invent another payment attempt. HTTP calls have a 10-second timeout.

Inside the service's network namespace, `polar-paykit inspect-marker OWNER_PUBLIC_KEY RECEIVER_PATH` independently fetches the real Pubky marker. `polar-paykit diagnose-session RECEIVER_UUID` verifies a persisted grant and tests rejection of a wrong client, owner and receiver scope. Stop that receiver first; diagnostics acquire its exclusive lock and emit only public pass/fail data.

## Verification

Run `cargo fmt --manifest-path paykit/Cargo.toml --check`, `cargo clippy --manifest-path paykit/Cargo.toml --locked --all-targets -- -D warnings`, `cargo test --manifest-path paykit/Cargo.toml --locked` and `cargo doc --manifest-path paykit/Cargo.toml --locked --no-deps`.

The unit/API suite starts no services. Real scenarios additionally create participants and both Bob receivers, inspect Pubky markers, independently restart a receiver, restart the full service, verify names/identities/markers/SDK grants, retry commands and preserve a second environment throughout. Network archives containing Paykit are currently rejected until the encrypted recovery format ships.
