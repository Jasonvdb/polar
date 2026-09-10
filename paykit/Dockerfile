FROM rust:1.96.0-bookworm@sha256:5e2214abe154fe26e39f64488952e5c991eeed1d6d6da7cc8381ae83927f0cfc AS build
RUN apt-get update && apt-get install -y --no-install-recommends cmake clang libclang-dev pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY . .
ARG CARGO_BUILD_JOBS=2
RUN cargo build --locked --release --bin polar-paykit -j ${CARGO_BUILD_JOBS}

FROM debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libssl3 && rm -rf /var/lib/apt/lists/*
COPY --from=build /build/target/release/polar-paykit /usr/local/bin/polar-paykit
EXPOSE 10090
STOPSIGNAL SIGTERM
ENTRYPOINT ["polar-paykit"]
CMD ["serve"]
