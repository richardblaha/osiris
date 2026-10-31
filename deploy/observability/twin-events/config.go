package processor

import (
	"fmt"
	"strconv"
	"strings"

	"go.opentelemetry.io/collector/component"
	"go.opentelemetry.io/collector/confmap"
)

// Severity names to OpenTelemetry's numbers.
var severityNumbers = map[string]int32{
	"trace": 1, "debug": 5, "info": 9, "warn": 13, "warning": 13, "error": 17, "fatal": 21, "panic": 21,
}

// The resource attributes copied onto an event, mapped to the stream entry's field names.
var defaultAttributes = map[string]string{
	"service.name":          "service",
	"k8s.cluster.name":      "cluster",
	"k8s.namespace.name":    "namespace",
	"k8s.pod.name":          "pod",
	"k8s.node.name":         "node",
	"k8s.container.name":    "container",
	"k8s.deployment.name":   "deployment",
	"k8s.statefulset.name":  "statefulset",
	"k8s.replicaset.name":   "replicaset",
	"k8s.job.name":          "job",
	"k8s.cronjob.name":      "cronjob",
	"k8s.pod.ip":            "pod_ip",
	"k8s.pod.uid":           "pod_uid",
	"container.image.name":  "image",
}

// Config of the `twin/events` processor: catch warn/error log records (per `min_severity`) and append each to a
// Redis stream, so the digital twin's API and Osiris's agent can react to them. Records pass through unchanged.
type Config struct {
	// Redis's address (redis://host:6379/0, with password in the URL when set).
	RedisURL string `mapstructure:"redis_url"`
	// The stream key the events go to (XADD, capped with MAXLEN ~).
	Stream string `mapstructure:"stream"`
	// The lowest severity caught: warn (13), error (17), fatal (21), or a number.
	MinSeverity string `mapstructure:"min_severity"`
	// Also read the severity from the body when the record carries none (klog's E/W/I prefix, a level= field).
	InferFromBody bool `mapstructure:"infer_from_body"`
	// The stream's approximate maximum length.
	MaxLen int64 `mapstructure:"max_len"`
	// The message's maximum length in the event (the rest is cut).
	MaxMessage int `mapstructure:"max_message"`
	// Extra resource attributes to copy onto the event (name -> field name; the defaults cover the usual ones).
	Attributes map[string]string `mapstructure:"attributes"`
	// Only these services' events (empty: all).
	IncludeServices []string `mapstructure:"include_services"`
	// Never these services' events.
	ExcludeServices []string `mapstructure:"exclude_services"`
}

var _ component.Config = (*Config)(nil)

func (c *Config) Validate() error {
	if c.RedisURL == "" {
		return fmt.Errorf("redis_url is required")
	}
	if _, err := c.minSeverityNumber(); err != nil {
		return err
	}
	if c.Stream == "" {
		return fmt.Errorf("stream is required")
	}
	return nil
}

func (c *Config) minSeverityNumber() (int32, error) {
	s := strings.ToLower(strings.TrimSpace(c.MinSeverity))
	if n, ok := severityNumbers[s]; ok {
		return n, nil
	}
	if n, err := strconv.Atoi(s); err == nil && n >= 1 && n <= 24 {
		return int32(n), nil
	}
	return 0, fmt.Errorf("min_severity %q is neither a name (warn, error, fatal) nor a number", c.MinSeverity)
}

func defaultConfig() *Config {
	return &Config{
		Stream:        "osiris:otel:events",
		MinSeverity:   "warn",
		InferFromBody: true,
		MaxLen:        10_000,
		MaxMessage:    2_000,
		Attributes:    defaultAttributes,
	}
}

var _ confmap.Unmarshaler = (*Config)(nil)

func (c *Config) Unmarshal(componentParser *confmap.Conf) error {
	*c = *defaultConfig()
	return componentParser.Unmarshal(c)
}
