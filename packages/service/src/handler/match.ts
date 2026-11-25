import { caught } from '../errors/index.ts';
import type { RouteKey } from '../spans/index.ts';
import type { Route } from './context.ts';
import { routes, type RouteMatch } from './routes.ts';

export { routes } from './routes.ts';

export function routeKeyOf(route: Route): RouteKey {
  return `${route.method} ${route.path}` as RouteKey;
}

export function matchRoute(method: string, pathname: string, table: readonly Route[] = routes): RouteMatch | undefined {
  const segments = pathname.split('/');

  for (const route of table) {
    if (route.method !== method) continue;

    const params = matchPath(route.path.split('/'), segments);

    if (params) return { route, params };
  }

  return undefined;
}

function matchPath(template: readonly string[], segments: readonly string[]): Record<string, string> | undefined {
  if (template.length !== segments.length) return undefined;

  const params: Record<string, string> = {};

  for (const [index, part] of template.entries()) {
    const segment = segments[index] ?? '';
    const name = /^\{(\w+)\}$/.exec(part)?.[1];

    if (name === undefined) {
      if (part !== segment) return undefined;
    } else {
      if (segment === '') return undefined;

      const value = decodeSegment(segment);

      if (value === undefined) return undefined;

      params[name] = value;
    }
  }

  return params;
}

function decodeSegment(segment: string): string | undefined {
  const decoded = caught(() => decodeURIComponent(segment));

  return decoded.ok ? decoded.value : undefined;
}
