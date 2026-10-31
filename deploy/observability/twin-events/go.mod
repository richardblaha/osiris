module github.com/richardblaha/osiris/observability/twin-events

go 1.24

// `go mod tidy` runs in the Dockerfile build; the versions below are the floor.
require (
	github.com/redis/go-redis/v9 v9.7.0
	go.opentelemetry.io/collector/component v0.161.0
	go.opentelemetry.io/collector/consumer v0.161.0
	go.opentelemetry.io/collector/pdata v1.37.0
	go.opentelemetry.io/collector/processor v0.161.0
	go.uber.org/zap v1.27.0
)
