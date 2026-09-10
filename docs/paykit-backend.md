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

`GET /v1/events?after=N` streams the latest 256 persisted events with SSE `id`, event type and `{sequence,type,payload}` data. Sequence numbers remain monotonic across trimming and restart. Reconnect with the last processed sequence and deduplicate by sequence. A cursor ahead of the environment or older than the retained window returns 409 `event_cursor_reset`. If a connected consumer falls behind that window, the stream emits `event: event_cursor_reset` with `{error:{code,message}}` data and closes without silently skipping the gap. In either case, reload `/v1/state` and explicitly reconnect with its `lastEventSequence`. The state query contains the complete current workspace and operation history; event retention never removes durable commands or their idempotency records.

`receiver.workspace` is an invalidation notification containing only `{receiverId}`. Refetch `/v1/state` for the latest full workspace; historical avatar/profile copies are not retained in events. Existing installations atomically compact their old event history on startup before readiness, preserving its final sequence. Renames remain observable in state and operation completion events. HTTP query failures never expose underlying SDK errors.

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

## Encrypted links, profiles and contacts

Receiver processes now own a bounded stdin/stdout command channel. The supervisor continuously consumes typed public workspace updates and command replies; no second process opens the SDK writer. Each receiver persists its pause setting, profile cache, owned avatar references and command outcomes in authenticated `workspace.cbor`. SDK transactions that change no state do not rewrite the encrypted SDK file. Public workspace events are emitted only when their content changes.

The v1 workspace commands are:

| Commands                                                                                           | Input                                                      |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `link.initiate`, `link.accept`, `link.advance`, `link.block`, `link.unblock`, `link.sendEmptyList` | `{receiverId,peerPublicKey,peerReceiverPath}`              |
| `delivery.pause`, `delivery.resume`, `delivery.sync`, `profile.delete`                             | `{receiverId}`                                             |
| `profile.publish`                                                                                  | `{receiverId,displayName,about,avatarBase64?,avatarMime?}` |
| `profile.fetch`, `contact.publish`, `contact.unpublish`                                            | `{receiverId,peerPublicKey,peerReceiverPath}`              |
| `contact.save`                                                                                     | `{receiverId,peerPublicKey,label,receiverPaths}`           |
| `contact.remove`, `contact.discover`                                                               | `{receiverId,peerPublicKey}`                               |

Peer keys must be canonical Pubky z-base32 public keys. Receiver paths follow the pinned SDK grammar: a 1–64 character lowercase ASCII letter/digit/hyphen app segment other than `private`, followed by `/wallet` or `/server`. Discovery only lists real public receiver markers; it never saves contacts or accepts a link. Same-owner encrypted links are rejected.

Initiation and acceptance are explicit. Background work advances existing linking peers and uses the SDK durable send queue and receive cursor for linked peers. It never automatically initiates a peer, unblocks a peer, or restarts a recovery-required handshake. Pause persists across restarts and prevents both outbound publication and inbound receipt; an empty list may still be queued while paused. `delivery.sync` fails visibly until resumed. Blocking clears the SDK link; unblocking requires explicit new linking.

`link.sendEmptyList` demonstrates the actual encrypted Private Payment List protocol with zero payment endpoints. Its string `outboundMessageId` identifies durable queue acceptance. `lastSentMessageId` is projected only from an SDK record with successful sent status and timestamp; the recipient independently exposes `latestReceivedListId`. These identifiers are strings to preserve full u64 precision. No payment execution or funded wallets ship in this increment.

Receiver intent is committed before SDK effects and its terminal result before emitting a reply. Identical receiver command IDs return the saved result. If the receiver was interrupted before recording its result, the intent fails visibly and affected private peers require explicit relinking. If the child completed but the supervisor did not record completion, supervisor restart marks the old operation `reconciliation_required`; it does not blindly dispatch it again. Keep the original ID and inspect receiver state. The deterministic unit test covers this exact persisted child-result/lost-supervisor-reply boundary; it does not claim a physical power-loss test.

Profiles and public contact markers use the existing receiver-scoped SDK namespace and grants. Saved contact labels stay local. Public sharing requires an explicit command and only one marker path per contact may be public or uncertain; unpublish before switching/removing that path. Failed publication/removal remains visible instead of being reported private.

Avatar publication accepts decoded PNG/JPEG files up to 256 KiB, at most 1024×1024 pixels, with a 16 MiB decoder allocation limit (`image` 0.25.10, PNG/JPEG features only). Invalid/truncated content and MIME mismatches are rejected before command acceptance. Omitting both avatar fields retains the previous reference; both empty removes it. Obsolete blobs are deleted only from tracked owned references through the SDK scoped blob API; cleanup errors fail the operation visibly. Fetched previews are actual bounded public blob reads under the advertised owner's receiver namespace, validated again and returned as at most 48×48 PNG thumbnail data URLs (aspect preserved, encoded data URL at most 16 KiB). Original published bytes and Pubky URIs remain unchanged. Arbitrary HTTP/file targets never load in the renderer. Public profile lookup distinguishes a missing profile from a failed fetch and preserves old cache on transport failure.

Additional diagnostics inside the service namespace:

- `inspect-private-list RECEIVER_UUID PEER_KEY PEER_PATH` requires the receiver stopped and its exclusive lock. It reports only valid list count, latest stream item ID and endpoint count from the actual SDK store.
- `inspect-contact OWNER_KEY RECEIVER_PATH PEER_KEY PEER_PATH` reads the real public contact marker and returns its public fields and whether an unexpected local label was present.

The cumulative real scenario runner retains all eleven environment stages and adds explicit links to both Bob receivers, queue/publication/receive evidence, offline delivery, independent inbound/outbound pause with restart, blocking, actual PNG/JPEG profile fetch, contact discovery/edit/sharing/cleanup and receiver-state persistence. CI validates the complete ordered stage list and cleanup report; a skipped stage cannot count as passing.

Read caches retain the 16 most recent fetched profiles and 64 discovery results. Saved contacts and linked peers are never silently evicted: each receiver permits 128 contacts and 64 peer records, with visible limit errors before creating more. Existing records remain editable at the limit. This bounds receiver IPC previews independently of original avatar size.

`inspect-avatar OWNER_KEY RECEIVER_PATH BLOB_NAME` reads one scoped original public avatar with the same size/content validation and returns its MIME, size and public base64 bytes (or `exists:false`). Real scenarios compare those bytes to the uploaded fixtures independently of thumbnail rendering.
