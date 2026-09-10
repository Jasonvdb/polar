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

A planned receiver stop drains the current SDK command or synchronization before exiting, so the SDK can release its persisted peer leases. Accepted operations remain running until their actual result arrives. Receiver Pubky and wallet HTTP requests each have a 15-second deadline; a batch can require several requests, so this is not a global stop deadline. Crashes and interrupted service operations still require the existing explicit reconciliation; stopping does not replay commands or clear SDK leases.

Startup also resumes unregistered participant intents with their saved IDs and owner keys before readiness. This recovers a failed manual signup after a service outage; its original failed operation remains terminal and visible.

Interrupted running **PR2 commands only** are requeued with an explicit `operation.requeued` event and execute using their existing IDs and saved intent. They never become successful merely because the service restarted. A receiver generation can advance again during crash recovery; completed duplicate commands do not restart it again. Wallet/payment commands use their own settlement reconciliation and do not inherit this replay policy.

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

`link.sendEmptyList` demonstrates the actual encrypted Private Payment List protocol with zero payment endpoints. Its string `outboundMessageId` identifies durable queue acceptance. `lastSentMessageId` is projected only from an SDK record with successful sent status and timestamp; the recipient independently exposes `latestReceivedListId`. These identifiers are strings to preserve full u64 precision. This command only exchanges endpoint metadata; payment execution and funding use the separate commands below.

Receiver intent is committed before SDK effects and its terminal result before emitting a reply. Identical receiver command IDs return the saved result. If the receiver was interrupted before recording its result, the intent fails visibly and affected private peers require explicit relinking. If the child completed but the supervisor did not record completion, supervisor restart marks the old operation `reconciliation_required`; it does not blindly dispatch it again. Keep the original ID and inspect receiver state. The deterministic unit test covers this exact persisted child-result/lost-supervisor-reply boundary; it does not claim a physical power-loss test.

Profiles and public contact markers use the existing receiver-scoped SDK namespace and grants. Saved contact labels stay local. Public sharing requires an explicit command and only one marker path per contact may be public or uncertain; unpublish before switching/removing that path. Failed publication/removal remains visible instead of being reported private.

Avatar publication accepts decoded PNG/JPEG files up to 256 KiB, at most 1024×1024 pixels, with a 16 MiB decoder allocation limit (`image` 0.25.10, PNG/JPEG features only). Invalid/truncated content and MIME mismatches are rejected before command acceptance. Omitting both avatar fields retains the previous reference; both empty removes it. Obsolete blobs are deleted only from tracked owned references through the SDK scoped blob API; cleanup errors fail the operation visibly. Fetched previews are actual bounded public blob reads under the advertised owner's receiver namespace, validated again and returned as at most 48×48 PNG thumbnail data URLs (aspect preserved, encoded data URL at most 16 KiB). Original published bytes and Pubky URIs remain unchanged. Arbitrary HTTP/file targets never load in the renderer. Public profile lookup distinguishes a missing profile from a failed fetch and preserves old cache on transport failure.

Additional diagnostics inside the service namespace:

- `inspect-private-list RECEIVER_UUID PEER_KEY PEER_PATH` requires the receiver stopped and its exclusive lock. It reports only valid list count, latest stream item ID and endpoint count from the actual SDK store.
- `inspect-contact OWNER_KEY RECEIVER_PATH PEER_KEY PEER_PATH` reads the real public contact marker and returns its public fields and whether an unexpected local label was present.

The cumulative real scenario runner retains all eleven environment stages and adds explicit links to both Bob receivers, queue/publication/receive evidence, offline delivery, independent inbound/outbound pause with restart, blocking, actual PNG/JPEG profile fetch, contact discovery/edit/sharing/cleanup and receiver-state persistence. CI validates the complete ordered stage list and cleanup report; a skipped stage cannot count as passing.

Read caches retain the 16 most recent fetched profiles and 64 discovery results. Saved contacts and linked peers are never silently evicted: each receiver permits 128 contacts and 64 peer records, with visible limit errors before creating more. Existing records remain editable at the limit. This bounds receiver IPC previews independently of original avatar size.

`inspect-avatar OWNER_KEY RECEIVER_PATH BLOB_NAME` reads one scoped original public avatar with the same size/content validation and returns its MIME, size and public base64 bytes (or `exists:false`). Real scenarios compare those bytes to the uploaded fixtures independently of thumbnail rendering.

## Receiving methods and endpoint reservations

Each receiver selects one trusted wallet binding with `method.configure`. Main owns
`wallet-config.json` beside the API credentials and mounts that directory read-only.
`PAYKIT_WALLET_CONFIG_FILE` points to the file; omitting it preserves the earlier
Pubky-only environment with an empty wallet catalog. The version 1 file contains
`environmentId` and `wallets`, each with `id`, `label`, `bitcoin` (`url`, `username`,
`password`) and optional `lightning` (`url`, `tlsCertPath`, `macaroonPath`). Receiver
commands accept a wallet ID, never RPC URLs or credentials. TLS verification stays
enabled. The invoice macaroon needs only `invoices:read` and `invoices:write`.

Canonical methods are `btc-onchain` and `btc-lightning-bolt11`. `enabledMethods` is
nonempty and unique; `preference` is an ordered subset that may be empty. Amounts
are canonical positive decimal **satoshi strings**, at most `2100000000000000`.
SDK selection receives the same exact decimal with asset `sat`; no floating point
or implicit BTC conversion is used. `expirySeconds` is an integer from 1 through 604800. BOLT11 validation checks the signature, regtest network, exact millisatoshi
amount and actual invoice expiry against the system clock. Address validation uses
the Bitcoin library's checksummed regtest address parser.

The following commands use the existing asynchronous operation API, CLI and MCP
command registry. Every input includes `receiverId`:

- `method.configure`: `walletId`, `enabledMethods`, `preference`.
- `method.prefer`: `preference`.
- `paymentList.publish`: `amountSats`, `expirySeconds`. Creates and publishes the
  complete enabled method set. `paymentList.unpublish` explicitly withdraws it.
- `reservation.create` and `reservation.rotate`: `peerPublicKey`,
  `peerReceiverPath`, `amountSats`, `expirySeconds`. Require an explicitly linked
  peer; rotate supersedes the earlier whole private list.
- `reservation.cancel` and `reservation.reconcile`: `reservationId`. Cancellation
  makes the entire associated list ineligible before wallet cleanup and queues a
  private withdrawal. Reconciliation uses the original issuance identity.
- `paymentList.resolve`: `peerPublicKey`, `peerReceiverPath`, `source` (`public` or
  `private`), `amountSats`, optional `method`. An explicit method or saved preference
  is required. Private resolution never falls back to public storage.
- `paymentList.consume`: `resolutionId`. Durably consumes a whole private list
  version for this receiver, peer and path. This reserves use of the list; it does
  **not** execute a payment. Another resolution of the same version, even on the
  other rail, becomes ineligible. A newer list is required after restart too.

Workspace fields `paymentMethods`, `publicPaymentList`, `reservations` and
`resolutions` expose safe current state. Lifecycle, delivery and wallet cleanup
have separate statuses. A queued withdrawal does not mean the remote receiver
has observed it. Public history shows the latest 128 reservations and resolutions;
internal issuance identities and consumed-version tombstones remain durable.

The receiver's encrypted atomic `payments.cbor` ledger persists issuance IDs and
reconciliation material before calling a wallet, then persists the actual endpoint
before SDK publication. LND uses a random preimage saved before AddInvoice and
reconciles by its hash; a confirmed missing invoice can be recreated only with
that same identity. Core uses a unique `paykit-reservation-<UUID>` label in the
participant wallet `paykit-<Pubky public key>`. An uncertain address issuance is
looked up by label and is never blindly repeated. Bob's receivers share participant
funds while keeping distinct receiver ledgers and reservation labels. Original
wallet bindings remain with historical records for cleanup.

Cancelled, expired and superseded Bitcoin addresses stay permanently assigned;
withdrawal cannot invalidate an already disclosed address. No address pool is
reused. Failed atomic commits poison further writes and prevent publication.
Uncertain issuance blocks replacement until explicit reconciliation or cancellation.
The SDK cancellation callback verifies reservation ID, peer, receiver path,
identifier, payload hash and attribution before cleanup. Already shared endpoints
are cleaned by the application; errors and SDK partial publication failures remain
visible. Background expiry and cleanup continue while private delivery is paused.

For independent diagnostics, `inspect-payment-endpoints OWNER PATH` reads actual
public Pubky endpoints. `inspect-private-list RECEIVER PEER PATH` additionally
returns the latest decrypted `paymentEndpoints`; the receiver must be stopped so
the diagnostic can acquire its existing exclusive SDK lock. These commands expose
endpoint payloads, never preimages, session grants, Noise keys or wallet credentials.
Actual payments and settlement/proof processing use the request commands described below.

The full disposable CLI demonstration is `node scripts/paykit-ci.js`: it provisions
real wallets and the response-loss fixture, requires all 48 stages in both
isolated environments and verifies owned-resource cleanup. Running
`scripts/paykit-scenarios.js` against a pre-existing Pubky-only environment requires
explicit `--pubky-only`; its report labels that narrower scope and contains the
earlier 23 stages. A missing wallet fixture never silently counts as a full run.

LND's generated certificate is trusted explicitly by the native TLS backend,
which accepts its self-signed CA certificate as the server certificate while still
checking its hostname and validity. This is scoped to the LND client. Independent
verification must reject a different node's certificate and an unmatched hostname;
TLS verification is never disabled.

## Requests, actual payments and settlement

The v1 API exposes `request.create/accept/reject/cancel`, `payment.execute/reconcile`,
`proof.submit/verify`, and `preset.fund`. Commands return an operation ID immediately.
The receiver workspace separately projects `requests`, `executions`, `proofs`, and
`settlements`; SDK `proofSubmitted` means an event exists, not that money settled.

Publish or rotate fresh endpoints for the exact requested amount before composing
`request.create`. Every accepted method needs an unclaimed endpoint. The receiver
checks its wallet: a Bitcoin address must have received zero funds, and a BOLT11
invoice must be open and unexpired. Public endpoints and private endpoints intended
for this exact payer receiver can be selected. The application claims reservations
in encrypted `requests.cbor` before proposing the SDK request, and copies their
source, method, endpoint and reservation ID into immutable SDK metadata. Payer
resolution and payee verification must match those bindings. Old unbound requests
cannot execute. Claimed endpoints are never assigned to another request.

`payment.execute` takes the payer receiver, request ID, trusted wallet ID, explicit
public/private source, and explicit method or saved preference. Amount and peer
come from the accepted SDK request. The application persists the complete execution
intent before wallet effects. A duplicate ID returns its operation, and a fresh ID
for the same request returns the existing execution. A private list is consumed
between durable execution reservation and a durable authorization checkpoint; an
incomplete checkpoint blocks execution. There is no public fallback.

The encrypted shared `receivers/wallet-execution/executions.cbor` coordinator locks
spending across receiver processes. The same Core participant wallet remains locked
across binding aliases; actual LND identities identify shared Lightning wallets.
Unresolved attempts block another spend on the same wallet. Bitcoin selected inputs
and outputs are committed before signing, and the exact signed bytes and transaction
ID before broadcasting. `testmempoolaccept` checks the original transaction. Dust is
rejected explicitly; below-dust change is omitted and added to the fee without changing
the requested output. Ambiguous errors stay uncertain. Reconciliation queries the
original wallet and only rebroadcasts the original bytes. Lightning persists the
invoice hash before sending; reconciliation queries paginated payment history by
that hash and distinguishes failed, in-flight and successful payments. It never
creates a replacement invoice/payment for an uncertain attempt.

`proof.submit` accepts a successful execution ID or an editable strict proof object:
`{method:"btc-onchain",txid,outputIndex}` or
`{method:"btc-lightning-bolt11",paymentHash,preimage}`. The pinned SDK owns event IDs,
queueing, delivery and lifecycle derivation. Payer role, accepted lifecycle, supported
terms and accepted rail are validated before reserving the proof checkpoint. Rejected
preflight input can be corrected after restart; uncertain SDK writes retain their
checkpoint until reconciled. Persisted application correlation and
existing SDK records recover interrupted event submission without regenerating an
event. `proof.verify` runs at the payee: Core transaction output script and amount
must match the request's own reservation; Lightning preimage/hash and independently
settled invoice amount must agree. A durable shared transaction-output/hash claim
prevents another request using the same payment. On-chain settlement defaults to one
confirmation; callers may require 1–144. Insufficient confirmations remain pending.
Verification failure, proof delivery, execution and receipt issuance remain separate;
receipt issuance is introduced in the following increment.

`preset.create` remains the Pubky-only preset. `preset.fund` additionally selects
three distinct actual LND identities sharing a trusted Core backend, provisions
mature regtest funds, funds each participant's Core wallet and LND wallet, and opens
Alice–Bob and Bob–Carol channels with balances on both sides. Funding transfers use
the same durable signed-transaction coordinator. Channel-open intent is persisted
before RPC and interrupted setup reconciles the original open/pending channel;
unknown outcomes never trigger another channel funding transaction. Root state
`funding` exposes progress, verified balances and channel points. Repeating funding
reuses original transfer and channel identities. Startup exposes interrupted funding
as `uncertain`, enabling explicit recovery without automatically replaying the command.
Undersized Core groups are skipped before reading setup credentials or making RPCs.

Wallet configuration adds `bitcoinBackendId` and optional Lightning
`paymentMacaroonPath`, `setupMacaroonPath`, and `peerAddress`. Electron main bakes
restricted URI grants using its local administrator credential, persists only those
grants for the service, and never exposes credentials through UI/API. Receiving,
payment/history/identity, and preset setup grants remain distinct. TLS verification
is enabled for every LND call. Core amounts use exact decimal text and integer
satoshis, including JSON/CBOR roundtrip tests.
