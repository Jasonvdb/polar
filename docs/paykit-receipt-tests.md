# Receipt integration tests

The full disposable scenario suite preserves the original 48 stages and adds 12 receipt stages in each of two independent environments. It uses real regtest Core/LND payments, independently verified proofs, actual Pubky encrypted objects, private Receipt Access delivery, and SDK decryption. Receipt operations are checked against unchanged wallet histories. Cached receipt retrieval is intentionally separate from fresh uncached corruption tests.

Build the production service normally and the non-shipping fixture explicitly:

```sh
docker build --target production -t polar-paykit/service:pr2 -f paykit/Dockerfile paykit
docker build --target receipt-fixture -t polar-paykit/receipt-fixture:local -f paykit/Dockerfile paykit
PAYKIT_RECEIPT_FIXTURE_IMAGE=polar-paykit/receipt-fixture:local node scripts/paykit-ci.js
node scripts/paykit-ci.js --verify-report /absolute/path/from/runner/output
```

`PAYKIT_TEST_IMAGE` optionally selects an immutable production image. Run these commands only within an allocated disposable Docker context and artifact/data root. The runner labels and records every container, including one-shot fixture clients. The production final image contains only `polar-paykit`, and each environment checks that the fixture executable is absent and the normal CLI usage remains available. `default-run = "polar-paykit"` also preserves local `cargo run` selection.

The fixture image has no server. It accepts only `inspect`, `delete`, `corrupt`, `wrong-key`, or `recover`, followed by a canonical receiver UUID and SDK-compatible receipt UUIDv4. It reads only that receiver's authenticated encrypted session/SDK snapshots, derives the exact target from a durable issuance record, and imports the existing grant in memory using a testnet-only Pubky client. It never opens the SDK writer or saves application/SDK state. No arbitrary URL, key, body or storage path is accepted.

Each client shares the service network namespace because the local Pubky testnet uses loopback addresses. Its root filesystem is read-only. Bind mounts are limited to the selected receiver directory and master key, both read-only, plus an owned private journal directory. The authenticated Pubky session performs the remote mutation. A fresh bearer may be obtained when importing the existing grant; the fixture does not create or revoke a grant.

Before any mutation, an exclusive mode-0600 journal containing the original ciphertext, exact identities and expected mutation digest is flushed to disk. Recovery accepts only the recorded original or exact fault state, restores byte-identical ciphertext, verifies a fresh public read, and durably marks the journal restored. The runner attempts restoration before resource cleanup, including when a scenario fails. Unresolved restoration retains the private run data and prevents a passing report. Private journals, session files and SDK snapshots are excluded from public CI artifacts. Public evidence contains only allowlisted IDs, actions, sizes, hashes and restoration status.

The three fault cases use separate, previously uncached receipts: missing object (NotFound), malformed encrypted JSON (Failed), and an otherwise valid receipt encrypted under a different generated key (Failed). They assert visible retrieval failure without plaintext history, then restore and successfully retrieve the original. A wrong key is never exported to the UI, API, MCP or fixture output.

Preparation followed by receiver/environment restart proves durability between explicit issuance phases. Paused delivery followed by restart/resume proves queued access recovery. Neither is described as a crash during a successful PUT. SDK commit-failure unit coverage and any exact-receipt-scoped after-PUT crash instrumentation must be reported separately with their actual boundaries; production has no corruption/fault command.

Finite checks are `node --test scripts/paykit-*.test.js`, Rust formatting/Clippy/unit/documentation checks, existing lint/types/Jest/build, and isolated TestCafe. The harness retains its 20-minute deadline; complete reports require all 60 stages in both environments, all receipt faults restored, distinct receiver/environment identities, surviving unrelated wallets and receivers, and verified owned-resource cleanup.
