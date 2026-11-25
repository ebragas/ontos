import { afterAll, beforeAll, expect } from 'vitest';
import type { UserSource } from '../../../packages/service/src/auth/index.ts';
import { TEST_APP, testAppUsers } from '../../../tools/packaging/testService.ts';
import { startTestService, type TestService } from '../../../tools/packaging/testService.test-utils.ts';
import { NOTES_GRANTS } from './apps.test-utils.ts';
import type { Handler } from './cli.test-utils.ts';

export interface LocalGate {
  readonly service: TestService;
  flags(): string[];
}

export const GATE_STAGING_URL = 'https://app-staging.ontos.example';

export function notesUsers(people: Readonly<Record<string, string>> = {}): UserSource {
  return testAppUsers((JSON.parse(NOTES_GRANTS) as { defaultRoles: Record<string, string[]> }).defaultRoles, people);
}

export function localGate(
  environment: 'staging' | 'production' = 'production',
  users: UserSource = testAppUsers(),
): LocalGate {
  let running: TestService | undefined;

  beforeAll(async () => {
    running = await startTestService(environment === 'staging' ? GATE_STAGING_URL : TEST_APP.production.baseUrl, users);
  });

  afterAll(async () => {
    await running?.stop();
  });

  const service = (): TestService => {
    if (!running) throw new Error('The service starts in beforeAll.');

    return running;
  };

  return {
    get service() {
      return service();
    },
    flags: () => ['--app', 'app', '--env', environment, '--url', service().url],
  };
}

export async function personEnv(service: TestService): Promise<{ ONTOLOGY_TOKEN: string }> {
  return { ONTOLOGY_TOKEN: await service.issuer.workos() };
}

export async function expectAllOnNewest(service: TestService): Promise<void> {
  const behind = await service.query<{ rid: string }>(
    `SELECT o.rid FROM ontology_registry.ontologies o
     WHERE o.version < (SELECT max(v.version) FROM ontology_registry.product_versions v WHERE v.product = o.product)`,
  );

  expect(behind).toEqual([]);
}

export const installGate = (service: TestService): Promise<void> => service.install();

export const toLocal: Handler = (call) =>
  call.url.startsWith('http://127.0.0.1:')
    ? fetch(call.url, {
        method: call.method,
        headers: call.headers,
        ...(call.body !== undefined ? { body: call.body } : {}),
      })
    : undefined;
