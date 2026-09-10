# Paykit participant workspace

Enable Paykit from a stopped network's **Paykit** tab, then start the network.
The **Network** tab retains the Bitcoin/Lightning workbench. Paykit readiness is
checked separately; a failed startup stops the partially started environment and
shows an error. Stop and start the network to restart the whole environment.

For this development increment, build `polar-paykit/service:pr2` using the
[backend setup](paykit-backend.md) before starting an enabled network. Docker
pulls the pinned PostgreSQL 18 image if it is not already installed. Missing
service images and unavailable host ports cause a visible startup failure.

Create named participants, or choose **Create Alice / Bob / Carol preset**. The
preset supplies Alice and Carol's wallet receivers plus Bob's wallet and server
receivers. It does not fund wallets or implement payments in this increment.
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
`preset.create`. Tool metadata documents required fields. The backend guide
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
