import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi, type MockInstance } from 'vitest';
import { handle, type HandleInput } from './index.ts';
import { ONTOLOGY_RID, startInstalled, type InstalledOntology } from './handler.test-utils.ts';

const path = `http://localhost/api/v2/ontologies/${ONTOLOGY_RID}/actions/com.example.crm.delete-company/applyBatch`;
let installed: InstalledOntology;
let input: HandleInput;
let token: string;
let consoleLog: MockInstance<typeof console.log>;

beforeAll(async () => {
  installed = await startInstalled();

  input = installed.input;

  token = await installed.issuer.workos();
});

afterAll(async () => {
  await installed?.stop();
});

beforeEach(() => {
  consoleLog = vi.spyOn(console, 'log');
});

afterEach(() => consoleLog.mockRestore());

it('ontology/action-types/action-types#out-of-scope: applyBatch with no token gets 401 MissingCredentials', async () => {
  const response = await handle(new Request(path, { method: 'POST', body: '{}' }), input);

  expect(response.status).toBe(401);

  expect(await response.json()).toEqual({
    errorCode: 'UNAUTHORIZED',
    errorName: 'MissingCredentials',
    errorInstanceId: expect.any(String),
    parameters: {},
  });
});

it.each([
  ['a batch of 2 requests', { requests: [{ parameters: { company: 'c-1' } }, { parameters: { company: 'c-2' } }] }],
  ['an empty body', {}],
])(
  'ontology/action-types/action-types#out-of-scope: applyBatch with a token and %s gets 400 with feature applyBatch',
  async (_, body) => {
    const response = await handle(
      new Request(path, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) }),
      input,
    );

    expect(response.status).toBe(400);

    expect(await response.json()).toEqual({
      errorCode: 'INVALID_ARGUMENT',
      errorName: 'Default:InvalidArgument',
      errorInstanceId: expect.any(String),
      parameters: { feature: 'applyBatch' },
    });
  },
);
