import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { linkedApp, twinGrants, twinOntology } from './apps.test-utils.ts';
import { cli, stubFetch, tempFolder, withoutDescriptionWarnings } from './cli.test-utils.ts';
import { localGate, installGate, personEnv, toLocal } from './sql.test-utils.ts';

const local = localGate();
const ACCOUNT = 'com.example.twin.Account';
const SET_PHASE = 'com.example.twin.set-phase-action';
const PHASES = ['prospect', 'customer', 'closed'];
const ONE_OF = { type: 'oneOf', options: PHASES.map((value) => ({ value })), otherValuesAllowed: false };

const FUNCTION = [
  'import type { Client } from "@osdk/client";',
  'import { createEditBatch, type Edits } from "@osdk/functions";',
  'import { Account } from "@ontology/sdk";',
  '',
  'type OntologyEdit = Edits.Object<Account>;',
  'type Phase = "prospect" | "customer" | "closed";',
  '',
  'export default function setPhase(client: Client, accountId: string, phase: Phase): OntologyEdit[] {',
  '  const batch = createEditBatch<OntologyEdit>(client);',
  '  batch.create(Account, { accountId, name: accountId, phase });',
  '  return batch.getEdits();',
  '}',
  '',
].join('\n');

const ONTOLOGY = `${twinOntology('0.7.0')}
defineFunctionBackedAction({
    functionApiName: "setPhase",
    apiName: "set-phase-action",
    displayName: "Set phase",
});
`;

let root: string;
let metadata: { actionTypes: Record<string, { parameters: Record<string, unknown> }> };

const run = async (args: readonly string[]) =>
  cli([...args, ...local.flags()], { cwd: tempFolder(), fetch: globalThis.fetch, env: await personEnv(local.service) });

beforeAll(async () => {
  root = linkedApp();

  writeFileSync(join(root, 'functions/typescript-functions/src/functions/setPhase.ts'), FUNCTION);

  writeFileSync(join(root, 'ontology/src/ontology.mts'), ONTOLOGY);

  const grants = JSON.parse(twinGrants('0.7.0')) as { actionTypes: Record<string, string> };

  writeFileSync(
    join(root, 'ontology/src/grants.json'),
    JSON.stringify({ ...grants, actionTypes: { ...grants.actionTypes, [SET_PHASE]: 'accounts:write' } }),
  );

  const generated = await cli(['generate-osdk'], { cwd: root, fetch: stubFetch() });

  expect(generated.stderr).toBe('');

  const published = await cli(['publish', ...local.flags()], {
    cwd: root,
    fetch: stubFetch(toLocal),
    env: local.service.oidcEnv,
  });

  expect(withoutDescriptionWarnings(published.stderr)).toBe('');

  await installGate(local.service);

  metadata = (published.output as { metadata: typeof metadata }).metadata;
}, 60_000);

describe('a Function input of string literals, end to end', () => {
  it('ontology/functions/functions#discovery, ontology/action-types/action-types#parameters: the published metadata gives the literals in validation, and generate-osdk writes the String parameter of the Action into the Ontology SDK', () => {
    const options = PHASES.map((value) => ({ displayName: '', value }));

    expect(metadata.actionTypes[SET_PHASE]?.parameters['phase']).toEqual({
      displayName: 'Phase',
      dataType: { type: 'string' },
      required: true,
      typeClasses: [],
      validation: { defaultValidation: { allowedValues: { type: 'oneOf', options, otherValuesAllowed: false } } },
    });

    expect(
      readFileSync(join(root, 'ontology/osdk-output/ontology/ontology/actions/setPhaseAction.ts'), 'utf8'),
    ).toContain("readonly phase: ActionParam.PrimitiveType<'string'>;");
  });

  it('ontology/functions/functions#function-backed-actions: the stock client of apply gets ActionValidationError with the oneOf constraint for a value outside the literals, and the Function does not run', async () => {
    for (const mode of [[], ['--validate-only']]) {
      const invalid = await run([
        'apply',
        SET_PHASE,
        '--parameters',
        '{"accountId":"acc-bad","phase":"lost"}',
        ...mode,
      ]);

      expect(invalid.code).toBe(1);

      expect(invalid.output).toEqual({
        result: 'INVALID',
        submissionCriteria: [],
        parameters: {
          accountId: { result: 'VALID', evaluatedConstraints: [], required: true },
          phase: { result: 'INVALID', evaluatedConstraints: [ONE_OF], required: true },
        },
      });
    }

    expect((await run(['objects', ACCOUNT, 'acc-bad'])).code).toBe(1);
  });

  it('ontology/functions/functions#function-backed-actions: apply with a literal runs the Function', async () => {
    const applied = await run(['apply', SET_PHASE, '--parameters', '{"accountId":"acc-good","phase":"customer"}']);

    expect(applied.stderr).toBe('');
    expect(applied.code).toBe(0);

    expect(await run(['objects', ACCOUNT, 'acc-good', '--select', '["phase"]'])).toMatchObject({
      output: { phase: 'customer' },
    });
  });
});
