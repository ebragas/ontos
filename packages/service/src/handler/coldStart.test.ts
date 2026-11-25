import { afterAll, expect, it, vi } from 'vitest';
import { createPool } from '../db/index.ts';
import { handle, type HandleInput } from './index.ts';
import { handlerDb, testInput, testSettings } from '../service.test-utils.ts';
import { createTestIssuer, PERSON } from '../tokens.test-utils.ts';

const downPool = createPool('postgresql://ontology_service:direct@127.0.0.1:1/neondb');
const DOWN_ERROR = 'connect ECONNREFUSED 127.0.0.1:1';

afterAll(() => downPool.end());

it('service/storage#engine-changes service/observability#logs service/observability#error-reports: a request that records no span gets its 503 log line and its fault report with no traceId and no rootSpanId', async () => {
  const issuer = await createTestIssuer(testSettings.auth);

  const down = handlerDb(downPool);
  const faults: unknown[][] = [];
  const reportFault: HandleInput['reportFault'] = (...args) => void faults.push(args);
  const log = vi.spyOn(console, 'log');

  try {
    const answer = await handle(
      new Request('http://localhost/api/v2/ontologies', {
        headers: { authorization: `Bearer ${await issuer.workos()}` },
      }),
      {
        ...testInput,
        db: down,
        directDb: down,
        keys: issuer.keys,
        reportFault,
      },
    );

    expect(answer.status).toBe(503);

    const { errorInstanceId } = (await answer.json()) as { errorInstanceId: string };

    const lines = log.mock.calls.map(([line]) => JSON.parse(String(line)) as unknown);

    const fields = {
      errorInstanceId,
      errorName: 'OntologyService:EngineChangesFailed',
      route: 'GET /api/v2/ontologies',
      userId: PERSON,
      callerKind: 'person',
    };

    expect(lines).toEqual([{ ...fields, routeParams: {}, parameters: {}, stack: expect.stringContaining(DOWN_ERROR) }]);
    expect(faults).toEqual([[expect.objectContaining({ message: DOWN_ERROR }), fields]]);
  } finally {
    log.mockRestore();
  }
});
