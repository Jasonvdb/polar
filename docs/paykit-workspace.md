# Paykit participant workspace

Enable Paykit from a stopped network's **Paykit** tab, then start the network.
The **Network** tab retains the Bitcoin/Lightning workbench. Paykit readiness is
checked separately; a failed startup stops the partially started environment and
shows an error. Stop and start the network to restart the whole environment.

For this development increment, build `polar-paykit/service:pr2` using the
[backend setup](paykit-backend.md) before starting an enabled network. Docker
pulls the pinned PostgreSQL 18 image if it is not already installed. Missing
service images and unavailable host ports cause a visible startup failure.

Create named participants, or choose **Create funded Alice / Bob / Carol preset**
on a network with at least three LND nodes sharing a Bitcoin Core backend. This
creates Alice and Carol's wallet receivers plus Bob's wallet and server receivers,
then provisions regtest funds and usable Lightning channels through the backend.
Funding progress and wallet balances are visible; readiness is reported only after
verification. Repeating the command reconciles the existing setup. The separate
**Create Alice / Bob / Carol preset** action creates identities without funding
and remains usable in a Pubky-only environment.
Select a participant to create or rename its receivers. Start, stop and restart
a selected receiver independently. Renaming changes its display name; the path,
identity and cryptographic state stay the same. Public keys, receiver path,
generation, lifecycle status and operation errors are visible in the workspace.

Every command has a UUID and returns an operation ID. The workspace refreshes
public state every second; failed operations remain in the history. If acceptance
is uncertain, **Retry command** resends the identical request and ID. Other
commands remain disabled until acceptance is resolved. A rejected request can be
corrected and submitted again. Long operations run in the backend rather than
holding Electron's MCP request open.

## MCP and CLI

The MCP `paykit` tool uses the same commands as the CLI and UI:

- `{ "networkId": 1, "action": "enable" }` provisions a stopped network.
- `{ "networkId": 1, "action": "state" }` returns public state.
- `{ "networkId": 1, "action": "command", "request": { "commandId": "<UUID>", "command": "preset.create", "input": {} } }` returns `{ "operationId": "<UUID>" }`.
- `{ "networkId": 1, "action": "operation", "operationId": "<UUID>" }` polls completion.

Commands are `participant.create`, `participant.rename`, `receiver.create`,
`receiver.rename`, `receiver.start`, `receiver.stop`, `receiver.restart` and
`preset.create`. Receiving, links, profiles and request/payment/proof commands
are documented below and in tool metadata, including every required field. The backend guide
covers CLI invocation, authenticated HTTP and the replayable event stream.

## Persistence and isolation

Each network stores a public environment UUID, API version and allocated service
port. The initial port is `10090 + POLAR_PAYKIT_PORT_OFFSET + networkId`, advanced
to an available port if needed. Startup checks that the assigned port is free.
Only the authenticated API is published, on `127.0.0.1`. PostgreSQL and local
Pubky services are private to the network. Receiver processes share the local
Pubky container's network namespace.

Electron's main process provisions random encryption, API and database credentials
in `<app-data>/paykit-credentials/<environmentId>/`, with private file permissions.
A separate public `network-<id>.json` binds these credentials to the network. The
renderer sends network IDs and public commands; the proxy looks up trusted paths
and endpoints. It never returns credential values or arbitrary operation-result
fields. Docker receives read-only credential mounts outside the network's export
directory. SDK state and PostgreSQL data persist in the owning network's
`volumes/paykit` and `volumes/paykit-postgres` directories. Both services run as
the host UID/GID, so private credential mounts remain readable and network data
can be removed by its owner.

Keep both the network data and main-process credential directory when restarting
or moving this development installation. Missing credentials require recovery;
Polar does not generate a replacement identity for an existing environment.
Deleting a network deletes its Paykit data and credentials after stopping it.
Paykit export and import are deliberately unavailable until validated Backup and
Recovery is implemented. Ordinary Polar network archives remain supported.

## Encrypted links and private delivery

Select a participant and a running receiver to open **Encrypted links** and
**Profiles / Contacts**. Changing receivers clears unfinished drafts. Every
command remains scoped to the selected receiver, including retries after an
uncertain submission.

Choose a local peer receiver or enter its public key and full receiver path.
Paths have the form `application/wallet` or `application/server`; the application
uses lowercase letters, digits and hyphens. Initiate a link on one receiver and
accept it on the peer. **Advance link** explicitly advances setup. Links show
handshake state, generation, failures and recovery requirements. Blocking stops
that peer; unblocking requires explicit relinking. After mutual blocking, unblock
both receivers successfully before initiating the new link. The peer may accept
later; its decision is never automatic. Unblocking first removes that receiver's
abandoned encrypted outbox for the selected peer. A cleanup or service failure
keeps the peer blocked and records a failed operation. Initiating while the other
receiver remains blocked can fail visibly and requires explicit recovery.

For backup recovery, select the exact counterparty and choose **Prepare recovery**
on the restored receiver, then on the healthy receiver, then once more on the
restored receiver. The local and peer preparation indicators must both be ready
on both sides before initiating and accepting the fresh link. Preparation does
not start the handshake. Ordinary new links are available immediately and do not
use this marker barrier.

**Pause private delivery** persists the receiver-wide inbound/outbound pause.
It retains links and queued messages; it does not pause link handshakes.
**Sync private delivery** is unavailable while paused. Resume delivery to process
pending work. **Queue empty encrypted list** demonstrates the real encrypted
payment-list transport without payment endpoints. Queued messages, an observed
published message and the latest received list have separate displays. Acceptance
of a command alone is not proof of delivery. Stop/start a receiver to exercise
outages while its peer remains available.

## Public profiles, avatars and local contacts

Edit a display name and biography, choose to retain, replace or remove the
avatar, then select **Publish profile**. PNG and JPEG uploads must be at most
256 KiB, at most 1024 × 1024 pixels, and decode as images before submission. The workbench shows supported
public avatar previews and the stored Pubky URI. It never loads arbitrary remote
image URLs. **Edit published profile** loads the current public text into the
form; **Delete published profile** removes this receiver's publication. Operation
failures, including obsolete-avatar cleanup failures, remain visible.

Enter a contact public key, a local label and receiver paths (one per line), then
**Save local contact**. **Discover receiver paths** queries public markers without
automatically saving or linking. Use the discovered paths in a draft, or edit an
existing contact. **Fetch public profile** requires a separate, explicit target
receiver path and can also fetch your own publication. Fetched profiles remain
associated with both the public key and receiver path.

Contacts start private. **Share contact publicly** explicitly publishes the
selected contact/path in this receiver's namespace. Labels remain local. Sharing
status distinguishes private, publishing, public, removing and error; pending or
failed work can still have a public marker. Unpublish the current shared path
before publishing another path, removing it from the contact or deleting the
contact. **Unpublish contact** uses the recorded shared path even if the draft
target has changed.

MCP and CLI expose the same `link.*`, `delivery.*`, `profile.*` and `contact.*`
commands. MCP metadata lists exact input fields; `receiverPaths` is a string
array, all other inputs are strings. `profile.publish` omits both avatar fields
to retain an image, sends both as empty strings to remove it, or sends
`avatarBase64` with `avatarMime` for a replacement. Query state or the accepted
operation ID for results. Public results are projected recursively by Electron;
SDK sessions, private keys and storage snapshots are never forwarded.

## Payment methods, lists and reservations

Add a Bitcoin Core node to use on-chain receiving. Add an LND node connected to
that Core backend to use BOLT11 receiving. Restart the network after changing
nodes. Select a running receiver, then open **Payment methods and reservations**.
The wallet catalog contains Core-only and LND/Core bindings. IDs follow node IDs,
so renaming or reordering nodes does not select a different wallet. Both receivers
under one participant use the same participant-specific Core wallet while keeping
separate reservation state. Polar's existing Bitcoin controls continue to use its
unnamed default wallet.

Choose a receiving wallet, enable supported methods and optionally choose methods
in preference order. **Save receiving configuration** stores this selection.
**Save method preference** updates the preference independently. Catalog status
`configured` means a trusted binding exists; it does not assert the wallet is
online. Wallet failures remain visible in the accepted operation and reservation.

Enter a positive whole-satoshi amount, up to `2100000000000000`, and an endpoint
expiry between 1 and 604800 seconds. **Publish public payment list** creates real
regtest addresses and/or BOLT11 invoices for every enabled method, then publishes
the complete list through Pubky. **Withdraw public payment list** explicitly
withdraws it. For private receiving, choose the intended peer's public key and
receiver path, establish an encrypted link, then **Create private reservation**.
**Rotate private reservation** supersedes the previous list with fresh endpoints.

History separates reservation lifecycle, eligibility, delivery and wallet cleanup.
A queued withdrawal is not confirmed delivery. Failed cleanup remains visible;
**Reconcile reservation** retries safe recovery using the original durable issuance
identity. **Cancel reservation** makes the reservation ineligible before cleanup.
Expired, cancelled and superseded Bitcoin addresses remain permanently assigned;
a previously revealed address cannot be revoked or reused for another reservation.

To discover a peer's receiving endpoint, choose **Public** or **Private encrypted
list** explicitly. Select a method override or use a saved nonempty preference.
**Resolve selected payment list** never changes source or silently substitutes an
unsupported override. Inspect the status, endpoint, exact private-list version and
expiry. **Consume private list without payment** records consumption durably and
prevents reuse of that private version. It does not execute a wallet payment.
Payment execution and proofs are described below.

MCP and CLI expose `method.configure`, `method.prefer`, `paymentList.publish`,
`paymentList.unpublish`, `reservation.create`, `reservation.rotate`,
`reservation.cancel`, `reservation.reconcile`, `paymentList.resolve` and
`paymentList.consume`. Use the standard command wrapper and poll its operation ID.
`enabledMethods` and `preference` are arrays of `btc-onchain` and/or
`btc-lightning-bolt11`; `amountSats` is a decimal string and `expirySeconds` is a
JSON integer. Resolution accepts `source: "public"` or `"private"` and an optional
`method`. Cancellation and reconciliation use `reservationId`; consumption uses
`resolutionId`. All commands include the selected `receiverId`.

Electron main atomically writes a versioned wallet configuration from validated
network nodes. It derives internal Docker service addresses, copies only LND's
TLS certificate and `invoices.macaroon` into its private credential directory,
and exposes that directory read-only to the service. Missing startup credentials
are retried during workspace queries; they do not prevent Pubky readiness.
LND connections verify the certificate and hostname. The UI and MCP accept wallet
catalog IDs, never credential paths, authentication values or arbitrary RPC URLs.

## Payment requests and real payments

First create the funded preset. Select the payee receiver, establish an encrypted
link to the payer using **Encrypted links**, and configure its receiving methods.
Publish a fresh public payment list or create/rotate a private reservation for
the exact request amount and every accepted method. Previously claimed endpoints
cannot be reused for a new request; private reservations must target this payer. Private lists remain receiver-scoped and require explicit private resolution.

In **Requests and payments**, select or enter the payer public key and receiver
path. Edit the exact satoshi amount, description, proposal expiry and accepted
methods, then choose **Create payment request**. On the payer receiver, inspect
its terms and immutable endpoint bindings (source, method, endpoint and reservation)
and choose **Accept request** or **Reject request**. **Cancel request**
sends the SDK cancellation for eligible requests. Proposal expiry is shown as a
proposal term; acceptance does not invent a new payment deadline.

To pay, select the accepted request, spending wallet, endpoint source and method.
An omitted method requires a saved preference. **Pay accepted request** executes
against the immutable accepted amount and its bound endpoint. The chosen source
and method must match one of the request bindings. Older requests without valid
bindings require a new proposal; they cannot be executed or verified as a new payment. The history shows
its wallet, endpoint, transaction output or Lightning payment hash and execution
status. A recorded execution prevents another payment from this form. If the
outcome is uncertain, **Reconcile execution** queries the original wallet payment
or rebroadcasts the identical signed transaction. Reconciliation never creates a
replacement payment. Wallet failures and insufficient funds remain visible.

## Proofs and independent settlement

In **Proofs and settlement**, select a request and its successful execution to
submit a prepared proof. **Enter proof manually** instead accepts either an
on-chain transaction ID and output index, or a Lightning payment hash and payment
preimage. These are public payment proof material. Session keys, wallet credentials
and transaction signing data are never displayed.

Switch to the payee receiver to inspect the delivered proof and choose **Verify
settlement**. On-chain settlement defaults to one confirmation; the editable depth
supports 1–144. A matching transaction below that depth remains pending. Invalid
proofs show a concrete mismatch; an unavailable wallet shows a verification error.
The request lifecycle, execution, proof delivery and settlement verification have
separate statuses. A submitted proof is not a settlement confirmation. Receipt
issuance is a separate explicit action after verification.

The MCP/CLI commands are `preset.fund`, `request.create`, `request.accept`,
`request.reject`, `request.cancel`, `payment.execute`, `payment.reconcile`,
`proof.submit` and `proof.verify`. All return operation IDs using the existing
asynchronous interface. The main process bakes separate URI-restricted LND payment
and setup credentials from each selected local node, using verified TLS; only the
restricted files enter the Paykit service mount. Initial authorization happens
before command acceptance and failures leave the backend operation unsubmitted.
The same backend funding/payment commands work in the standalone CLI without
Electron.

## Encrypted receipts and access

On the payee receiver, **Receipts and access** offers only request/proof pairs
with an independently verified settlement. Select the exact proof and inspect
its request, amount, method, recipient key and receiver path. Edit the optional
note (up to 500 UTF-8 bytes, without control characters), then **Prepare receipt**.
The note preserves whitespace. Preparation saves an immutable local draft; it
does not publish a receipt. Each receiver/request/proof has one stable receipt
identity. Its payment terms come from the retained request and proof, and its
original note and draft cannot be replaced by repeating preparation.

**Issued receipt history** separates receipt issuance from access delivery.
**Process / resume receipt** stores the encrypted receipt in Pubky and queues
access through the existing private link. A pendingStorage receipt is only
prepared locally; stored means the encrypted object was stored; accessQueued
means access was queued locally. Delivery sent means the private stream was
published, not that the recipient has retrieved the receipt. Existing encrypted
link controls resume paused delivery or recover a link. Restarting a receiver
preserves prepared drafts, ciphertext and access identities. After a terminal
failure, retry processing the original receipt; it must not issue a new receipt
or trigger another wallet payment. Recovery or relinking errors remain visible.

On the payer receiver, **Received access** identifies each receipt by its issuer
public key **and receiver path**. Choose **Retrieve and decrypt receipt**, or
**Retry retrieval and decryption** after a missing object or decryption failure.
The same receipt ID from a different issuer path is a different selection.
A valid cached receipt can be returned without another download. Missing objects,
invalid decryption and known-request mismatches remain failed access entries;
they are not presented as successfully decrypted receipt history.

**Decrypted receipt history** shows only the safe receipt contents and their
issuer namespace. Foreign SDK receipts may omit supported amount, method or
request metadata; these fields are labeled as absent or unsupported. Decryption
is not independent settlement verification. Session secrets, Noise secrets,
receipt keys, raw access messages and encrypted SDK records never enter the UI
or MCP response.

The same asynchronous commands are available through MCP and the standalone CLI:

- `receipt.prepare`: `receiverId`, `requestId`, `proofId`, optional `note`.
- `receipt.process`: `receiverId`, `receiptId`.
- `receipt.retrieve`: `receiverId`, `receiptId`, issuer `peerPublicKey` and
  `peerReceiverPath` from received access.

Request, proof and receipt IDs must be canonical lowercase RFC 4122 UUIDv4 values
accepted by the pinned SDK. Receiver IDs remain canonical non-nil UUIDs, including
the preset's version 5 receiver identities. Treat receipt IDs as opaque values
returned by the backend.

Poll the returned operation ID. For uncertain command acceptance, **Retry command**
reuses the original command ID. After an accepted operation fails or is interrupted,
the receipt action submits a fresh command ID with the original receipt identity.
Receipt controls remain disabled until the accepted receipt operation finishes.
No command accepts receipt keys, ciphertext, arbitrary URLs or replacement payment
terms.

## Subscriptions and recurring requests

Choose a participant and receiver, then use **Subscriptions and billing periods** to compose recurring terms. Enter the payer’s exact receiver, satoshis per period, accepted methods, recurrence interval/unit, and a UTC start/anchor such as `2026-09-11T12:00:00Z`. An optional end must be a full period boundary. Minute, hour, day, week, month and year units use full anchored UTC periods; month/year dates clamp to the last available day and there is no proration. Fresh endpoints are prepared separately for each period after the payer accepts the terms.

As the payee, select the subscription and a started period, explicitly choose public or private endpoints, and select **Prepare period endpoints**. This uses the receiving wallet and methods configured in Payment methods and reservations. The encrypted period offer authorizes those immutable endpoints only for that period. It is not an additional payment request to accept or pay.

As the payer, select the same subscription and period, spending wallet, endpoint source and method (or your saved method preference for manual payment). **Pay selected period manually** also supports missed periods. Enter a period’s zero-based index if it is outside the displayed history; preparing it makes its recorded offer visible. An existing execution blocks another payment for that period, including after failure or an uncertain result. Inspect and reconcile the original execution in Requests and payments.

Autopay is off by default. **Enable autopay for this request** explicitly authorizes its selected wallet, source and method. It attempts only the current period when the payee’s offer arrives and submits the successful execution’s proof. It never collects missed-period backlog. Failed and uncertain attempts require manual attention; re-enabling authorization does not clear an execution. **Disable autopay for this request** leaves the subscription manually payable. **Cancel subscription** stops future authorization, while an already started wallet execution remains reconcilable.

A period’s payment, proof delivery, independently verified settlement, and receipt issuance are separate states. Use Proofs and settlement to submit or verify a period proof, then Receipts and access to prepare, process and retrieve its receipt. The proof selector, execution history and receipt history show the relevant billing-period dates.

### Receiver application time

The receiver clock controls affect only the selected receiver’s SDK/application schedule and persist across receiver restart. Enter canonical UTC second precision and use **Set receiver application time** to freeze or advance time. Set both peers’ clocks as needed for a demonstration; changing one receiver does not change another. Advancing time can trigger autopay already authorized for the new current period. Bitcoin time and real wallet invoice expiry remain independent, so a logically current period can still need a fresh real-time invoice.

Time cannot move backward. Returning to system time is blocked while real time is behind the receiver’s effective time. The UI displays this condition and the backend enforces it. For a two-period/missed-period demonstration, pay the first period, advance and pay the second, advance past a period without preparing its offer, then prepare and pay that older index manually. Restart the receiver, verify the same execution history, cancel, and confirm no later payment occurs.

The MCP `paykit` tool and CLI use the same versioned operations: optional `request.create.recurrence`, `subscription.prepare`, `subscription.authorize`, `subscription.disable`, `payment.execute.periodIndex`, `proof.submit.periodIndex`, `clock.set`, and `clock.reset`. Commands return an operation ID immediately. Retry uncertain acceptance with the original command ID; observe the operation’s terminal status before another action. Raw recurring proofs require a period index; execution-backed proofs derive it. Session, Noise and receipt keys remain outside the renderer and public API.

Period offers use compact SHA-256 endpoint commitments so BOLT11 invoices fit the SDK’s encrypted message limit. A payer initially sees the endpoint’s hash, source, method and reservation identity. Payment resolves the real endpoint and verifies that it matches the accepted commitment before any wallet side effect; the resolved endpoint then appears in period/execution history. Public/private selection remains explicit. Previously validated full-endpoint offers remain supported.
