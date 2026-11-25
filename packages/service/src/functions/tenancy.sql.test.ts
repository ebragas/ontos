import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NS, rowsOf, startActions, type ActionsService } from '../actions/actions.test-utils.ts';
import { installOnce } from '../install.test-utils.ts';
import { USE } from '../ontology/stored.test-utils.ts';
import { ORGANIZATION, OTHER_ORGANIZATION, PERSON } from '../tokens.test-utils.ts';
import { stubUsers } from '../workos.test-utils.ts';
import { actionOf, withFunctions, type TestFunction } from './functions.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const OTHER_RID = 'ri.ontology.main.ontology.00000000-0000-4000-8000-000000000627';

const FUNCTIONS: TestFunction[] = [
  {
    apiName: 'remember',
    inputs: [
      { name: 'accountId', type: 'string' },
      { name: 'secret', type: 'string' },
    ],
    edits: [ACCOUNT],
  },
];

const SOURCE = `
import { createEditBatch } from '@osdk/functions';

let kept;

export const functions = {
  remember: async (client, accountId, secret) => {
    const previous = { module: kept ?? null, global: globalThis.memo ?? null, prototype: ({}).memo ?? null };
    kept = secret;
    globalThis.memo = secret;
    Object.defineProperty(Object.prototype, 'memo', { value: secret, configurable: true });
    const batch = createEditBatch(client);
    batch.create({ type: 'object', apiName: '${ACCOUNT}' }, { accountId, name: JSON.stringify(previous) });
    return batch.getEdits();
  },
};
`;

let service: ActionsService;

beforeAll(async () => {
  const { ir, functions } = await withFunctions(FUNCTIONS, SOURCE);

  service = await startActions(ir, functions);

  await installOnce(service.db, OTHER_RID, 'twin', OTHER_ORGANIZATION);
});

afterAll(() => service?.stop());

const BOTH_ORGANIZATIONS = stubUsers(
  undefined,
  [ORGANIZATION, OTHER_ORGANIZATION].map((organization) => ({
    user_id: PERSON,
    organization_id: organization,
    status: 'active' as const,
    roles: ['member'],
  })),
  { roles: { [ORGANIZATION]: { member: [USE] }, [OTHER_ORGANIZATION]: { member: [USE] } } },
);

const remember = (accountId: string, secret: string, ontology?: string) =>
  service.apply(
    actionOf('remember'),
    { parameters: { accountId, secret } },
    ontology ? { ontology, claims: { org_id: OTHER_ORGANIZATION }, users: BOTH_ORGANIZATIONS } : {},
  );

describe('the module state of a Function', () => {
  it('ontology/functions/functions#runtime: a call on 1 installation does not read the module state that a call on another installation left, and a call on the same installation does', async () => {
    expect((await remember('acc-a', 'secret-of-A')).status).toBe(200);

    expect((await remember('acc-b', 'secret-of-B', OTHER_RID)).status).toBe(200);

    expect((await remember('acc-a2', 'secret-of-A2')).status).toBe(200);

    const names = async (schema: string) =>
      Object.fromEntries(
        (await rowsOf(service.db, ACCOUNT, 'account_id', schema)).map((row) => [
          row['account_id'],
          JSON.parse(String(row['name'])),
        ]),
      );

    expect(await names('ontology_2_objects')).toEqual({ 'acc-b': { module: null, global: null, prototype: null } });

    expect(await names('ontology_1_objects')).toEqual({
      'acc-a': { module: null, global: null, prototype: null },
      'acc-a2': { module: 'secret-of-A', global: 'secret-of-A', prototype: 'secret-of-A' },
    });
  });
});
