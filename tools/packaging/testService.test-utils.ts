import type pg from 'pg';
import type { UserSource } from '../../packages/service/src/auth/index.ts';
import { rejecting } from '../../packages/service/src/db/promise.test-utils.ts';
import {
  startTestService as startFallibleTestService,
  type TestService as FallibleTestService,
} from './testService.ts';

type Calls = 'run' | 'serve' | 'install' | 'query' | 'stop';

export interface TestService extends Omit<FallibleTestService, Calls> {
  run(...args: Parameters<FallibleTestService['run']>): Promise<{ code: number; lines: string[]; stderr: string }>;
  serve(env: Readonly<Record<string, string | undefined>>): Promise<string>;
  install(): Promise<void>;
  query<Row extends pg.QueryResultRow>(text: string, values?: readonly unknown[]): Promise<Row[]>;
  stop(): Promise<void>;
}

export async function startTestService(
  baseUrl: string,
  users?: UserSource,
  clientSecret?: string,
): Promise<TestService> {
  const service = await rejecting(startFallibleTestService(baseUrl, users, clientSecret));

  return {
    ...service,
    run: (script, args, env) => rejecting(service.run(script, args, env)),
    serve: (env) => rejecting(service.serve(env)),
    install: () => rejecting(service.install()),
    query: <Row extends pg.QueryResultRow>(text: string, values?: readonly unknown[]) =>
      rejecting(service.query<Row>(text, values)),
    stop: () => rejecting(service.stop()),
  };
}
