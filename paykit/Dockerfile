FROM rust:1.96.0-bookworm@sha256:5e2214abe154fe26e39f64488952e5c991eeed1d6d6da7cc8381ae83927f0cfc AS build
RUN apt-get update && apt-get install -y --no-install-recommends cmake clang libclang-dev pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
ARG CARGO_BUILD_JOBS=2
# Cache only dependency artifacts. Delete every stub-package output and fingerprint.
RUN mkdir src && printf 'fn main() {}\n' > src/main.rs \
    && cargo build --locked --release --bin polar-paykit -j ${CARGO_BUILD_JOBS} \
    && rm -rf src target/release/.fingerprint/polar-paykit-* target/release/deps/polar_paykit-* target/release/polar-paykit
COPY src ./src
RUN cargo build --locked --release --bin polar-paykit -j ${CARGO_BUILD_JOBS} \
    && ./target/release/polar-paykit 2>&1 | grep -F 'Usage: polar-paykit'

FROM build AS fixture-build
ARG CARGO_BUILD_JOBS=2
RUN cargo build --locked --release --bin paykit-receipt-fixture -j ${CARGO_BUILD_JOBS}
RUN cargo build --locked --release --bin paykit-backup-fixture -j ${CARGO_BUILD_JOBS}

FROM debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171 AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libssl3 && rm -rf /var/lib/apt/lists/*
FROM runtime AS receipt-fixture
COPY --from=fixture-build /build/target/release/paykit-receipt-fixture /usr/local/bin/paykit-receipt-fixture
ENTRYPOINT ["paykit-receipt-fixture"]

FROM runtime AS backup-fixture
COPY --from=fixture-build /build/target/release/paykit-backup-fixture /usr/local/bin/paykit-backup-fixture
ENTRYPOINT ["paykit-backup-fixture"]

FROM runtime AS production
COPY --from=build /build/target/release/polar-paykit /usr/local/bin/polar-paykit
EXPOSE 10090
STOPSIGNAL SIGTERM
ENTRYPOINT ["polar-paykit"]
CMD ["serve"]
