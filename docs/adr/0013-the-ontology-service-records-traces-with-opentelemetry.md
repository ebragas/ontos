# The Ontology service records traces with OpenTelemetry

Before this decision, operators could not see where a request of the Ontology service spent its time. Runtime logs gave the total duration of each request. The request log gave only the lock wait of a publish or an upgrade. Nothing showed the time of the token check, an identity provider read, an Ontology compile, a SQL statement, a Function run, or an MCP sub-route. So each request now records 1 trace, with 1 named span at each seam. [Traces](../service/observability.md#traces) and [Trace export](../service/observability.md#trace-export) state the rules.

## Decision

- The service writes spans with the OpenTelemetry API, and exports them over OTLP to any configured standard OTLP collector (`OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS`), Sentry, or PostHog. Each destination is optional, and standard OTLP keeps observability vendor-neutral and reversible.
- 1 span catalog is the one list of span names, attribute kinds, and required child spans. The attribute types, the attribute filter, and the check of required spans come from it.
- No attribute takes a plain string. So no customer data can enter a span, by the types. An error records only its type.
- Error reports use the optional Sentry SDK when `SENTRY_DSN` is set. Each report carries the trace ID.
- Each request records a trace by default when tracing is enabled, and `TRACES_SAMPLE_RATE` lowers the rate.

## Considered Options

- The Sentry SDK tracing with `tracesSampleRate`, and PostHog apart. It gives 2 span APIs and 2 sample rules, so the 2 tools see different data. Its automatic `pg` spans record the text of each query. Sources: [Postgres for Node.js](https://docs.sentry.io/platforms/javascript/guides/node/configuration/integrations/postgres/) (it uses `@opentelemetry/instrumentation-pg`), [`utils.ts` of `instrumentation-pg`](https://github.com/open-telemetry/opentelemetry-js-contrib/blob/c9ddfed6ee4cd1ca0e9430485b5b73289400f436/packages/instrumentation-pg/src/utils.ts#L250) (`span.setAttribute(ATTR_DB_QUERY_TEXT, queryConfig.text)`). Its automatic `http` spans also record URLs. This is an inference: [HTTP for Node.js](https://docs.sentry.io/platforms/javascript/guides/node/configuration/integrations/http/) says only that it "captures spans for incoming and outgoing HTTP requests".
- Automatic `http`, `fetch`, and `pg` instrumentation. It records URLs and values, which the data rule forbids.
- The raw OpenTelemetry API in each module. Each seam then takes a free string, records exception messages, and must know the data rule, and the check of required spans has no source.
- A tracer in `HandleInput` and in the request context. `createDb` builds its `Db` at module scope, so each SQL span needs the tracer through each layer. Also, the service gets 2 ways to start a span.
- `@vercel/otel`. It owns the flush, but it hides the flush rule that the tests must pin. Its `fetch` spans record the full URL. Source: [`fetch.ts` of `@vercel/otel`](https://github.com/vercel/otel/blob/a5d519d95c4853ef6ab6b32f32628b107032c4e0/packages/otel/src/instrumentations/fetch.ts#L238) (`[SemanticAttributes.HTTP_URL]: url.toString()`).
- A flush with no time limit after the body ends. A body that never closes then holds the instance open indefinitely.
- A free PostHog URL setting. A hand edit could then send spans to any host.
- A 503 for the whole service on a bad trace setting. Traces are not worth an outage, so the service turns that destination off and sends 1 error report.

## Consequences

- Each traced request pays for a flush after its body ends, of at most 3 seconds. With traces off, the cost is 0.
- A new span is 2 edits: 1 entry in the catalog, and 1 call at the seam. A new outgoing call needs its own named span, and the route tests check it.
- The work of the cold start belongs to the trace of the request that runs it.
- The ingestion endpoint of PostHog can answer success for data that it cannot use, so verify end-to-end ingestion by reading a trace back in the backend UI after enabling export. Source: [Node.js tracing installation](https://posthog.com/docs/distributed-tracing/installation/nodejs) ("The ingestion endpoint returns a success response even when it can't use the data").
- Operators configure latency alerts externally once they establish a traffic baseline.
