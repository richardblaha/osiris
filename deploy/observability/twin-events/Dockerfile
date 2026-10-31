# The cluster's OpenTelemetry Collector image: the components deploy/observability/collector.yaml uses plus this
# repo's twin_events processor (warn/error log records appended to a Redis stream). Build:
#   docker build -t ghcr.io/richardblaha/osiris-otel-collector:main deploy/observability/twin-events
#   docker push ghcr.io/richardblaha/osiris-otel-collector:main
FROM golang:1.26-bookworm AS builder
WORKDIR /src
COPY go.mod go.sum* ./
COPY *.go ./
COPY cmd ./cmd
# The dependency versions are resolved here (go.sum is not in git).
RUN go mod tidy
RUN CGO_ENABLED=0 go build -trimpath -o /otelcol ./cmd/otelcol

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=builder /otelcol /otelcol
EXPOSE 4317 4318 4319 4320
ENTRYPOINT ["/otelcol"]
CMD ["--config=/conf/config.yaml"]
