import type { CATALOG, ValueOf } from './catalogData.ts';
import type { RouteKey } from './catalogHelpers.ts';

export * from './catalogHelpers.ts';

type Catalog = typeof CATALOG;

export type SpanName = keyof Catalog;

export type Empty<T> = [T] extends [never] ? true : T;

type Named<N extends SpanName> = Catalog[N] extends { readonly named: true }
  ? { readonly 'route.key': RouteKey }
  : unknown;

export type StartAttributes<N extends SpanName> = keyof Catalog[N]['start'] extends never
  ? Readonly<Record<string, never>>
  : { readonly [K in keyof Catalog[N]['start']]?: ValueOf<Catalog[N]['start'][K]> } & Named<N>;
