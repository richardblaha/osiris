package processor

import (
	"context"

	"go.opentelemetry.io/collector/component"
	"go.opentelemetry.io/collector/consumer"
	"go.opentelemetry.io/collector/processor"
	"go.opentelemetry.io/collector/processor/processorhelper"
)

const (
	typeStr   = "twin/events"
	stability = component.StabilityLevelAlpha
)

// NewFactory makes the `twin/events` processor: warn/error log records (per config) are appended to a Redis stream
// for the digital twin and Osiris's agent; everything passes through unchanged.
func NewFactory() processor.Factory {
	return processor.NewFactory(
		typeStr,
		func() component.Config { return defaultConfig() },
		processor.WithLogs(createLogs, stability),
	)
}

func createLogs(ctx context.Context, set processor.Settings, cfg component.Config, next consumer.Logs) (processor.Logs, error) {
	c := cfg.(*Config)
	p, err := newEventsProcessor(set, c)
	if err != nil {
		return nil, err
	}
	return processorhelper.NewLogs(
		ctx,
		set,
		cfg,
		next,
		p.processLogs,
		processorhelper.WithCapabilities(consumer.Capabilities{MutatesData: false}),
		processorhelper.WithStart(func(ctx context.Context, host component.Host) error { return nil }),
		processorhelper.WithShutdown(p.shutdown),
	)
}
