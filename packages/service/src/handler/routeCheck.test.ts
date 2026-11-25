import { PLATFORM_API_IR } from '@osdk/docs-spec-platform';
import { describe, expect, it } from 'vitest';
import { routes } from './index.ts';

function shape(path: string): string {
  return path.replace(/\{[^}]+\}/g, '{}');
}

const operations = new Set(
  PLATFORM_API_IR.namespaces.flatMap((namespace) =>
    namespace.resources.flatMap((resource) =>
      resource.operations.map((operation) => `${operation.http.httpMethod} ${shape(operation.http.path)}`),
    ),
  ),
);

const foundryRoutes = routes.filter((route) => route.path.startsWith('/api/v2/'));

describe('the route check', () => {
  it('has the 19 OSDK routes of http-api.md that the service serves today', () => {
    expect(foundryRoutes).toHaveLength(19);
  });

  it.each(foundryRoutes.map((route) => [route.method, route.path] as const))(
    '%s %s is in PLATFORM_API_IR',
    (method, path) => {
      expect(operations).toContain(`${method} ${shape(path.replace(/^\/api/, ''))}`);
    },
  );

  it('finds no operation for a path that OSDK does not have', () => {
    expect(operations).not.toContain('GET /v2/ontologies/{}/nope');
  });
});
