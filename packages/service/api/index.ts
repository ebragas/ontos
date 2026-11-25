import { readFileSync } from 'node:fs';
import * as Sentry from '@sentry/node';
import { attachDatabasePool, waitUntil } from '@vercel/functions';
import { PostHog } from 'posthog-node';
import { createPool } from '../src/db/index.ts';
import { caught, settle } from '../src/errors/index.ts';
import { handle, inputFromEnv, type McpFaultFields, type ReportFault } from '../src/handler/index.ts';
import { readPosthogConfig, ROOT_END_CAP_MS, startTracing, within, type PostHogConfig } from './_tracing.ts';

Error.stackTraceLimit = 30;

const BACKGROUND_CAP_MS = 5_500;

const input = inputFromEnv(
  process.env,
  (connectionString) => {
    const pool = createPool(connectionString);

    attachDatabasePool(pool);

    return pool;
  },
  [],
  { onBackground: (pending) => waitUntil(settle(within(pending, BACKGROUND_CAP_MS)).then(() => undefined)) },
);

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  readonly version: string;
};

const { tracing, badVariables } = startTracing(process.env, version);
const sentryDsn = process.env.SENTRY_DSN === '' ? undefined : process.env.SENTRY_DSN;

if (sentryDsn !== undefined) {
  Sentry.init({
    dsn: sentryDsn,
    environment: process.env.ONTOLOGY_ENVIRONMENT,
    release: version,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      stackFrameVariables: false,
    },
    maxBreadcrumbs: 0,
    tracePropagationTargets: [],
    integrations: (defaults) => defaults.filter((integration) => integration.name !== 'Dedupe'),
    beforeSend(event) {
      delete event.request;

      return event;
    },
  });
}

const sentryEnabled = sentryDsn !== undefined && Sentry.getClient()?.getDsn() !== undefined;
const posthogConfig: PostHogConfig | undefined = readPosthogConfig(process.env).config;

const posthog =
  posthogConfig === undefined
    ? undefined
    : new PostHog(posthogConfig.token, {
        host: posthogConfig.host,
        disableGeoip: true,
        enableExceptionAutocapture: false,
        captureTracingHeaders: false,
        flushInterval: 0,
        requestTimeout: 2000,
        captureMaxRetries: 0,
        beforeSend(event) {
          if (event.properties !== undefined) {
            delete event.properties['request'];

            delete event.properties['$request'];

            delete event.properties['headers'];

            delete event.properties['$headers'];

            delete event.properties['cookies'];

            delete event.properties['$cookies'];

            delete event.properties['body'];

            delete event.properties['$body'];

            delete event.properties['requestBody'];

            delete event.properties['$request_body'];

            delete event.properties['$ip'];

            if (event.properties['trace_id'] === undefined) {
              delete event.properties['$trace_id'];

              delete event.properties['$span_id'];
            }
          }

          return event;
        },
      });

posthog?.on('error', () => undefined);

let coldStartReport = sentryEnabled && badVariables.length > 0;

if (badVariables.length > 0) {
  const message = `These trace variables are not valid, so their destinations are off: ${badVariables.join(', ')}.`;

  if (sentryEnabled) Sentry.captureException(new Error(message));
  else console.error(message);
}

export default {
  async fetch(request: Request): Promise<Response> {
    let sentryReported = coldStartReport;
    let posthogReported = false;

    coldStartReport = false;

    const reportFault: ReportFault = (error, { userId, mcp, traceId, rootSpanId, ...tags }) => {
      if (sentryEnabled) {
        sentryReported = true;

        Sentry.captureException(error, {
          tags: { ...tags, ...mcpTags(mcp), ...(traceId === undefined ? {} : { trace_id: traceId }) },
          ...(userId === undefined ? {} : { user: { id: userId } }),
          ...(traceId === undefined || rootSpanId === undefined
            ? {}
            : { contexts: { trace: { trace_id: traceId, span_id: rootSpanId } } }),
        });
      }

      if (posthog !== undefined) {
        posthogReported = true;

        const environment = process.env.ONTOLOGY_ENVIRONMENT;

        caught(() =>
          posthog.captureException(error, {
            ...(userId === undefined ? {} : { distinctId: userId }),
            properties: {
              ...tags,
              ...mcpTags(mcp),
              ...(userId === undefined ? {} : { userId }),
              ...(environment === undefined || environment === '' ? {} : { environment }),
              release: version,
              ...(traceId === undefined ? {} : { trace_id: traceId }),
              ...(traceId === undefined || rootSpanId === undefined
                ? {}
                : { $trace_id: traceId, $span_id: rootSpanId }),
            },
          }),
        );
      }
    };

    const flushReports = (): Promise<unknown> | undefined => {
      const flushSentry = sentryEnabled && sentryReported;
      const flushPosthog = posthog !== undefined && posthogReported;

      sentryReported = false;

      posthogReported = false;

      if (!flushSentry && !flushPosthog) return undefined;

      const flushPosthogBounded = () => {
        if (posthog === undefined) return Promise.resolve();

        return caught(async () => settle(within(Promise.resolve(posthog.flush()), 2000))).then(() => undefined);
      };

      if (flushSentry && !flushPosthog) return Sentry.flush(2000);

      if (!flushSentry && flushPosthog) return flushPosthogBounded();

      return Promise.allSettled([Sentry.flush(2000), flushPosthogBounded()]).then(() => undefined);
    };

    const bodyPending = (settled: Promise<void>) =>
      waitUntil(settle(within(settled, ROOT_END_CAP_MS)).then(() => flushReports()));

    // D1: the Vercel runtime waits for the Promise of fetch and reads its rejection, so a handler that rejects rejects here.
    const { response, flush } = await tracing.serve(() => handle(request, { ...input, reportFault, bodyPending }));

    const reportFlush = flushReports();

    if (reportFlush !== undefined) waitUntil(reportFlush);

    if (flush !== undefined) waitUntil(flush);

    return response;
  },
};

function mcpTags(mcp: McpFaultFields | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(mcp ?? {}).map(([key, value]) => [`mcp.${key}`, value]));
}
