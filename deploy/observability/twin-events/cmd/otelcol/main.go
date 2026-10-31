// The cluster's collector binary: contrib/core components deploy/observability/collector.yaml uses, plus this
// module's twin_events processor (warn/error log records to a Redis stream). Built by the Dockerfile in this
// directory; no ocb needed.
package main

import (
	"log"

	"go.opentelemetry.io/collector/component"
	"go.opentelemetry.io/collector/confmap"
	envprovider "go.opentelemetry.io/collector/confmap/provider/envprovider"
	fileprovider "go.opentelemetry.io/collector/confmap/provider/fileprovider"
	httpprovider "go.opentelemetry.io/collector/confmap/provider/httpprovider"
	httpsprovider "go.opentelemetry.io/collector/confmap/provider/httpsprovider"
	yamlprovider "go.opentelemetry.io/collector/confmap/provider/yamlprovider"
	"go.opentelemetry.io/collector/exporter"
	"go.opentelemetry.io/collector/otelcol"
	"go.opentelemetry.io/collector/processor"
	"go.opentelemetry.io/collector/receiver"
	otelconftelemetry "go.opentelemetry.io/collector/service/telemetry/otelconftelemetry"

	clickhouseexporter "github.com/open-telemetry/opentelemetry-collector-contrib/exporter/clickhouseexporter"
	k8sclusterreceiver "github.com/open-telemetry/opentelemetry-collector-contrib/receiver/k8sclusterreceiver"
	k8sobjectsreceiver "github.com/open-telemetry/opentelemetry-collector-contrib/receiver/k8sobjectsreceiver"
	prometheusreceiver "github.com/open-telemetry/opentelemetry-collector-contrib/receiver/prometheusreceiver"
	k8sattributesprocessor "github.com/open-telemetry/opentelemetry-collector-contrib/processor/k8sattributesprocessor"
	resourceprocessor "github.com/open-telemetry/opentelemetry-collector-contrib/processor/resourceprocessor"
	batchprocessor "go.opentelemetry.io/collector/processor/batchprocessor"
	memorylimiterprocessor "go.opentelemetry.io/collector/processor/memorylimiterprocessor"
	otlpreceiver "go.opentelemetry.io/collector/receiver/otlpreceiver"

	twinevents "github.com/richardblaha/osiris/observability/twin_events"
)

func main() {
	factories := otelcol.Factories{
		Receivers: map[component.Type]receiver.Factory{
			otlpreceiver.NewFactory().Type():           otlpreceiver.NewFactory(),
			k8sclusterreceiver.NewFactory().Type():     k8sclusterreceiver.NewFactory(),
			k8sobjectsreceiver.NewFactory().Type():     k8sobjectsreceiver.NewFactory(),
			prometheusreceiver.NewFactory().Type():     prometheusreceiver.NewFactory(),
		},
		Processors: map[component.Type]processor.Factory{
			batchprocessor.NewFactory().Type():           batchprocessor.NewFactory(),
			memorylimiterprocessor.NewFactory().Type():   memorylimiterprocessor.NewFactory(),
			resourceprocessor.NewFactory().Type():        resourceprocessor.NewFactory(),
			k8sattributesprocessor.NewFactory().Type():   k8sattributesprocessor.NewFactory(),
			twinevents.NewFactory().Type():               twinevents.NewFactory(),
		},
		Exporters: map[component.Type]exporter.Factory{
			clickhouseexporter.NewFactory().Type(): clickhouseexporter.NewFactory(),
		},
		Telemetry: otelconftelemetry.NewFactory(),
	}
	cmd := otelcol.NewCommand(otelcol.CollectorSettings{
		Factories: func() (otelcol.Factories, error) { return factories, nil },
		BuildInfo: component.BuildInfo{Command: "otelcol-osiris", Description: "OpenTelemetry Collector with twin_events (warn/error log records to a Redis stream for the digital twin)", Version: "0.161.0"},
		ConfigProviderSettings: otelcol.ConfigProviderSettings{
			ResolverSettings: confmap.ResolverSettings{
				ProviderFactories: []confmap.ProviderFactory{
					envprovider.NewFactory(),
					fileprovider.NewFactory(),
					httpprovider.NewFactory(),
					httpsprovider.NewFactory(),
					yamlprovider.NewFactory(),
				},
			},
		},
	})
	if err := cmd.Execute(); err != nil {
		log.Fatal(err)
	}
}
