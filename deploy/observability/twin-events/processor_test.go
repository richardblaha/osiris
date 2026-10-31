package processor

import (
	"testing"

	"go.opentelemetry.io/collector/pdata/plog"
)

func rec(severityNumber plog.SeverityNumber, severityText, body string) plog.LogRecord {
	r := plog.NewLogRecord()
	r.SetSeverityNumber(severityNumber)
	r.SetSeverityText(severityText)
	r.Body().SetStr(body)
	return r
}

func TestSeverityOf(t *testing.T) {
	p := &eventsProcessor{cfg: &Config{InferFromBody: true}, min: 13}
	cases := []struct {
		name                 string
		rec                  plog.LogRecord
		wantN                int32
		wantText             string
	}{
		{"own number", rec(plog.SeverityNumberError, "", "boom"), 17, "ERROR"},
		{"from text", rec(plog.SeverityNumberUnspecified, "Warn", "x"), 13, "WARN"},
		{"klog error prefix", rec(plog.SeverityNumberUnspecified, "", "E0912 10:00:00.000 x.go:1] boom"), 17, "ERROR"},
		{"klog warn prefix", rec(plog.SeverityNumberUnspecified, "", "W0912 10:00:00.000 x.go:1] slow"), 13, "WARN"},
		{"level field", rec(plog.SeverityNumberUnspecified, "", `msg="x" level=error`), 17, "ERROR"},
		{"info stays below", rec(plog.SeverityNumberUnspecified, "", "all good"), 0, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			n, text := p.severityOf(c.rec)
			if n != c.wantN || text != c.wantText {
				t.Fatalf("got (%d, %q), want (%d, %q)", n, text, c.wantN, c.wantText)
			}
		})
	}
	// Without inference, a body saying error is not read.
	pNo := &eventsProcessor{cfg: &Config{InferFromBody: false}, min: 13}
	if n, _ := pNo.severityOf(rec(plog.SeverityNumberUnspecified, "", "E0912 level=error boom")); n != 0 {
		t.Fatalf("without infer_from_body the body is ignored, got %d", n)
	}
}

func TestConfigValidate(t *testing.T) {
	if err := (&Config{RedisURL: "redis://localhost:6379", Stream: "s", MinSeverity: "warn"}).Validate(); err != nil {
		t.Fatal(err)
	}
	if err := (&Config{Stream: "s", MinSeverity: "warn"}).Validate(); err == nil {
		t.Fatal("missing redis_url must fail")
	}
	if err := (&Config{RedisURL: "redis://x", Stream: "s", MinSeverity: "loud"}).Validate(); err == nil {
		t.Fatal("bad min_severity must fail")
	}
	if n, _ := (&Config{MinSeverity: "17"}).minSeverityNumber(); n != 17 {
		t.Fatal("numeric min_severity")
	}
}
