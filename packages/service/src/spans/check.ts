import { SpanStatusCode, type AttributeValue, type SpanStatus } from '@opentelemetry/api';
import { isRouteKey, type SpanName } from './catalog.ts';
import { CATALOG } from './catalogData.ts';
import { DROPPED } from './spanCore.ts';

export interface FinishedSpan {
  readonly name: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | undefined;
  readonly start: bigint;
  readonly end: bigint;
  readonly status: SpanStatus;
  readonly attributes: Readonly<Record<string, AttributeValue>>;
  readonly events: number;
}

interface CheckOptions {
  readonly rootRequires?: readonly SpanName[];
}

function catalogName(name: string): SpanName | undefined {
  for (const [entry, value] of Object.entries(CATALOG) as [SpanName, (typeof CATALOG)[SpanName]][]) {
    if (!('named' in value)) {
      if (name === entry) return entry;
    } else if (isRouteKey(entry === 'root' ? name : name.startsWith(`${entry} `) ? name.slice(entry.length + 1) : '')) {
      return entry;
    }
  }

  return undefined;
}

const holdsCanary = (value: AttributeValue): boolean =>
  (Array.isArray(value) ? value : [value]).some((item) => typeof item === 'string' && item.includes('CANARY'));

const SHARED_READS: ReadonlySet<unknown> = new Set([
  'membership',
  'role',
  'application',
  'members page',
  'applications page',
  'memberships page',
]);

const sharedRead = (s: FinishedSpan): boolean => SHARED_READS.has(s.attributes['workos.read']);

export function checkTrace(spans: readonly FinishedSpan[], options: CheckOptions = {}): string[] {
  const problems: string[] = [];
  const byId = new Map(spans.map((s) => [s.spanId, s]));

  const isRoot = (s: FinishedSpan): boolean =>
    s.parentSpanId === undefined || (catalogName(s.name) === 'root' && !byId.has(s.parentSpanId));

  const root = spans.find(isRoot);

  if (root === undefined) problems.push('no root span');

  for (const s of spans) {
    const report = (problem: string): number => problems.push(`${s.name}: ${problem}`);
    const entry = catalogName(s.name);

    if (entry === undefined) report('not in the span catalog');

    if (isRoot(s) && s !== root) report('a second root');

    if (root !== undefined && s.traceId !== root.traceId) report('not in the trace of the root');

    const parent = s.parentSpanId === undefined ? undefined : byId.get(s.parentSpanId);

    if (s.parentSpanId !== undefined && !isRoot(s) && parent === undefined) report('its parent is not in the trace');

    if (s.end < s.start) report('ends before it starts');

    if (parent !== undefined && s.start < parent.start) report('starts before its parent');

    if (parent !== undefined && s.end > parent.end && !sharedRead(s)) report('ends after its parent');

    const dropped = s.attributes[DROPPED];

    if (typeof dropped === 'number' && dropped > 0) report(`${dropped} dropped attribute${dropped === 1 ? '' : 's'}`);

    if (s.name.includes('CANARY') || Object.values(s.attributes).some(holdsCanary)) report('holds a CANARY value');

    if (s.status.code === SpanStatusCode.ERROR) continue;

    const required = [
      ...(entry === undefined ? [] : CATALOG[entry].requires),
      ...(s === root ? (options.rootRequires ?? []) : []),
    ];

    const children = new Set(
      spans.filter((child) => child.parentSpanId === s.spanId).map((child) => catalogName(child.name)),
    );

    for (const name of required) if (!children.has(name)) report(`no child ${name}`);
  }

  return problems;
}
