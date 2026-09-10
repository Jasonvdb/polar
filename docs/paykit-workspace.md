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
