# The cluster's OpenTelemetry Collector image: contrib 0.161.0 plus this repo's twin/events processor
# (warn/error log records appended to a Redis stream). Build:
#   docker build -t ghcr.io/richardblaha/otel-collector:main deploy/observability/twin-events
#   docker push ghcr.io/richardblaha/otel-collector:main
FROM golang:1.24-bookworm AS builder
WORKDIR /src
COPY go.mod ./
COPY processor ./processor
# The dependency versions are resolved here (go.sum is not in git).
RUN go mod tidy
RUN go install go.opentelemetry.io/collector/cmd/builder@v0.161.0
COPY builder-config.yaml ./
RUN /go/bin/builder --config builder-config.yaml

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=builder /build/otelcol-osiris /otelcol
EXPOSE 4317 4318 4319 4320
ENTRYPOINT ["/otelcol"]
CMD ["--config=/conf/config.yaml"]
