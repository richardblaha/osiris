package processor

import (
	"context"
	"encoding/hex"
	"fmt"
	"regexp"
	"strings"
	"sync/atomic"
	"time"

	"github.com/redis/go-redis/v9"
	"go.opentelemetry.io/collector/component"
	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/plog"
	"go.opentelemetry.io/collector/processor"
	"go.uber.org/zap"
)

// klog's severity prefix (E0102 …), and a level/severity field in the text (the twin infers the same in ClickHouse).
var (
	klogPrefix = regexp.MustCompile(`^[EWIF]\d{4}`)
	levelField = regexp.MustCompile(`(?i)"?(?:level|severity|lvl)"?\s*[=:]\s*"?(trace|debug|info|warn|warning|error|fatal|panic)`)
)

type eventsProcessor struct {
	cfg     *Config
	min     int32
	redis   *redis.Client
	logger  *zap.Logger
	dropped atomic.Int64
	written atomic.Int64
}

func newEventsProcessor(set processor.Settings, cfg *Config) (*eventsProcessor, error) {
	min, err := cfg.minSeverityNumber()
	if err != nil {
		return nil, err
	}
	opts, err := redis.ParseURL(cfg.RedisURL)
	if err != nil {
		return nil, fmt.Errorf("redis_url: %w", err)
	}
	p := &eventsProcessor{cfg: cfg, min: min, redis: redis.NewClient(opts), logger: set.Logger}
	meter := set.MeterProvider.Meter("twin/events")
	if _, err := meter.Int64Counter("twin_events_written"); err != nil {
		return nil, err
	}
	return p, nil
}

func (p *eventsProcessor) shutdown(ctx context.Context) error {
	return p.redis.Close()
}

// severityOf the record's severity number, from its text when it has none, else inferred from the body.
func (p *eventsProcessor) severityOf(rec plog.LogRecord) (int32, string) {
	if n := rec.SeverityNumber(); n != plog.SeverityNumberUnspecified {
		return int32(n), strings.ToUpper(rec.SeverityText())
	}
	if s := strings.ToLower(rec.SeverityText()); s != "" {
		if n, ok := severityNumbers[s]; ok {
			return n, strings.ToUpper(s)
		}
	}
	if p.cfg.InferFromBody {
		body := rec.Body().Str()
		if m := klogPrefix.FindString(body); m != "" {
			switch m[0] {
			case 'E', 'F':
				return 17, "ERROR"
			case 'W':
				return 13, "WARN"
			case 'I':
				return 9, "INFO"
			}
		}
		if m := levelField.FindStringSubmatch(body); m != nil {
			if n, ok := severityNumbers[strings.ToLower(m[1])]; ok {
				return n, strings.ToUpper(m[1])
			}
		}
	}
	return 0, ""
}

func (p *eventsProcessor) processLogs(ctx context.Context, ld plog.Logs) (plog.Logs, error) {
	rls := ld.ResourceLogs()
	for i := 0; i < rls.Len(); i++ {
		rl := rls.At(i)
		res := rl.Resource()
		service, _ := res.Attributes().Get("service.name")
		if len(p.cfg.IncludeServices) > 0 && !contains(p.cfg.IncludeServices, service.Str()) {
			continue
		}
		if contains(p.cfg.ExcludeServices, service.Str()) {
			continue
		}
		sls := rl.ScopeLogs()
		for j := 0; j < sls.Len(); j++ {
			records := sls.At(j).LogRecords()
			for k := 0; k < records.Len(); k++ {
				rec := records.At(k)
				n, sev := p.severityOf(rec)
				if n < p.min {
					continue
				}
				p.addEvent(ctx, res, rec, n, sev)
			}
		}
	}
	return ld, nil
}

// addEvent appends one record to the stream; a Redis failure never blocks the pipeline (best effort).
func (p *eventsProcessor) addEvent(ctx context.Context, res pcommon.Resource, rec plog.LogRecord, n int32, sev string) {
	message := rec.Body().Str()
	if p.cfg.MaxMessage > 0 && len(message) > p.cfg.MaxMessage {
		message = message[:p.cfg.MaxMessage]
	}
	fields := map[string]interface{}{
		"ts":              time.Now().UnixMilli(),
		"severity":        sev,
		"severity_number": n,
		"message":         message,
	}
	if id := rec.TraceID(); id.IsEmpty() == false {
		fields["trace_id"] = hex.EncodeToString(id[:])
	}
	if id := rec.SpanID(); id.IsEmpty() == false {
		fields["span_id"] = hex.EncodeToString(id[:])
	}
	for attr, field := range p.cfg.Attributes {
		if v, ok := res.Attributes().Get(attr); ok {
			fields[field] = v.AsString()
		}
	}
	cctx, cancel := context.WithTimeout(ctx, 200*time.Millisecond)
	defer cancel()
	err := p.redis.XAdd(cctx, &redis.XAddArgs{
		Stream: p.cfg.Stream,
		MaxLen: p.cfg.MaxLen,
		Approx: true,
		Values: fields,
	}).Err()
	if err != nil {
		p.dropped.Add(1)
		p.logger.Warn("twin/events: writing the event to Redis failed, dropped", zap.Error(err))
		return
	}
	p.written.Add(1)
}

func contains(list []string, v string) bool {
	for _, s := range list {
		if s == v {
			return true
		}
	}
	return false
}

var _ component.Component = (*eventsProcessor)(nil)
