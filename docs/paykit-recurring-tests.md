# Recurring payment verification

`node scripts/paykit-ci.js` runs all earlier 60 stages and ten recurring stages in each of two disposable real Pubky/PostgreSQL/Bitcoin Core/LND environments. Build the service and the existing non-shipping receipt fixture first, as described in the backend setup. No additional services or dependencies are needed. `node scripts/paykit-ci.js --verify-report <report-directory>` requires all 70 stages, existing wallet/fault/cleanup evidence, and the recurring evidence schema. An incomplete or timed-out run fails.

The recurring stages exercise:

- Explicit acceptance without payment, per-request wallet/source/method authorization, future-period rejection and hidden period-offer rejection by ordinary payment commands.
- On-chain public payments and BOLT11 private payments: period 0 paid manually; period 1 automatically paid only after the payee prepares its endpoint offer; period 2 skipped while the payer is offline, prepared later without automatic collection, then paid manually.
- Compact period commitments match the payee's exact endpoint bytes and the payer's later resolved execution endpoint. The payer initially sees commitments without raw endpoints; prepayment invoice clock checks read authenticated payee bindings.
- Separate execution, proof submission and independent settlement records with exact billing boundaries, plus encrypted receipt issuance, access delivery and decryption for each rail.
- Duplicate command IDs, repeated commands and actual background ticks without another wallet payment; enabled authorization, controlled clocks and history preserved through an environment restart; cancellation and receiver isolation.
- Insufficient funds, an invoice expired by actual elapsed time, and a successful Lightning payment whose response is dropped. The uncertain attempt blocks another execution, survives receiver restart and reconciles by its original payment hash.
- Application time advanced beyond a real invoice's expiry timestamp while that invoice remains valid by wallet time and is successfully paid. Bitcoin's best block remains unchanged across a clock-only jump. A backward clock reset fails and retains the controlled clock.

The application clock is intentionally left controlled in these disposable environments. Advancing it cannot rewind Bitcoin or invoice time. A single-use expired period offer remains a visible blocked outcome; the test does not pretend an unsupported endpoint refresh can recover it.

The public report contains explicit period/execution/proof/receipt identifiers, payment hashes or transaction IDs, wallet-history digests and clock evidence. It excludes raw proofs, preimages, signed transactions, SDK state and credentials. Schema guards reject unknown fields, incomplete rails, reused period payment identities, automatic payment of the missed period and altered no-replay evidence.

Run finite harness guards with `node --test scripts/paykit-*.test.js`. Calendar arithmetic, supported UTC recurrence units and clamped monthly/yearly anchors are tested in Rust. UI command controls and validation are covered by Jest and require separate native manual verification. The 20-minute scenario deadline remains unchanged; per-stage progress timestamps must establish sufficient headroom before merging.
