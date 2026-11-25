import { describe, expect, it } from 'vitest';
import { bindReader, policySql } from '../db/index.ts';
import type { CompiledObjectType, Policy, PolicyOperator } from '../ontology/index.ts';
import { planChanges } from './plan.ts';
import { objectType, ontology, property } from './publish.test-utils.ts';
import { UserId } from '../auth/caller.ts';

const SCHEMAS = { object: 'ontology_1_objects', engine: 'ontology_1_engine' };
const CREATE_INDEX = `CREATE INDEX "policy_account_allowed_teams_d5a27a94" ON "ontology_1_objects"."account" USING gin ((coalesce(array_remove("allowed_teams", NULL), '{}')))`;
const DROP_INDEX = 'DROP INDEX IF EXISTS "ontology_1_objects"."policy_account_allowed_teams_d5a27a94"';

function compare(name: string, operator: PolicyOperator = 'intersects'): Policy {
  return { kind: 'compare', object: { kind: 'property', property: name }, operator, person: { kind: 'permissions' } };
}

function account(policy?: Policy, propertyPolicy?: Policy): CompiledObjectType {
  const teams = property('allowedTeams', 'allowed_teams', { kind: 'array', element: { kind: 'string' } });

  const type = objectType('Account', 'account', 'accountId', [
    property('accountId', 'account_id', { kind: 'string' }, true),
    property('ownerId', 'owner_id', { kind: 'string' }),
    propertyPolicy ? { ...teams, policy: propertyPolicy } : teams,
  ]);

  return policy ? { ...type, policy } : type;
}

function plan(after: CompiledObjectType, before?: CompiledObjectType) {
  const changes = planChanges(
    SCHEMAS,
    ontology({ objectTypes: [after] }),
    before && ontology({ objectTypes: [before] }),
  );

  return changes.map((change) => ({
    description: change.description,
    statements: change.statements.map((statement) => statement.text),
  }));
}

const policyIndexes = (changes: ReturnType<typeof plan>) =>
  changes.flatMap((change) => change.statements).filter((text) => text.includes('policy_'));

describe('service/storage#indexes: each String array Property that the object security policy reads gets a GIN index on the compared expression', () => {
  it('service/storage#indexes: a new Object Type whose policy reads allowedTeams plans the policy index in its create change', () => {
    const [create] = plan(account(compare('allowedTeams')));

    expect(create?.description).toBe('Create Object Type Account');
    expect(create?.statements).toContain(CREATE_INDEX);
  });

  it('service/storage#indexes: the indexed expression is the array side that policySql compares, with the row alias removed', () => {
    const type = account(compare('allowedTeams'));

    const { reader } = bindReader(SCHEMAS, {
      userId: UserId.parse('user_ann'),
      permissions: ['member'],
      attributes: new Map(),
    });

    const read = policySql(compare('allowedTeams'), type, 's', reader, { add: () => '$1' });
    const [index] = policyIndexes(plan(type));
    const expression = /USING gin \(\((.+)\)\)$/.exec(index ?? '')?.[1];

    expect(expression).toBe(`coalesce(array_remove("allowed_teams", NULL), '{}')`);
    expect(read).toContain(`cardinality(${expression?.replace('"allowed_teams"', 's."allowed_teams"')}) > 0`);
  });

  it('service/storage#indexes: a policy that reads only String Properties plans no policy index', () => {
    expect(policyIndexes(plan(account(compare('ownerId'))))).toEqual([]);
  });

  it('service/storage#indexes: a Property that only a property security policy reads gets no policy index', () => {
    expect(policyIndexes(plan(account(undefined, compare('allowedTeams'))))).toEqual([]);
  });

  it('service/storage#indexes: a Property that 2 conditions read gets 1 index', () => {
    const both: Policy = {
      kind: 'or',
      conditions: [
        compare('allowedTeams', 'intersects'),
        { kind: 'and', conditions: [compare('ownerId'), compare('allowedTeams', 'supersetOf')] },
      ],
    };

    expect(policyIndexes(plan(account(both)))).toEqual([CREATE_INDEX]);
  });
});

describe('service/publish#upgrade: a step creates the policy index that the object security policy starts to read, and drops it when no policy reads it', () => {
  it('service/publish#upgrade: a policy that starts to read allowedTeams creates the index as its own named change', () => {
    expect(plan(account(compare('allowedTeams')), account())).toEqual([
      {
        description: 'Create the policy index of Property allowedTeams of Object Type Account',
        statements: [CREATE_INDEX],
      },
    ]);
  });

  it('service/publish#upgrade: a policy that stops reading allowedTeams drops the index, also when the step removes the whole policy', () => {
    const drop = [
      {
        description: 'Drop the policy index of Property allowedTeams of Object Type Account',
        statements: [DROP_INDEX],
      },
    ];

    expect(plan(account(compare('ownerId')), account(compare('allowedTeams')))).toEqual(drop);
    expect(plan(account(), account(compare('allowedTeams')))).toEqual(drop);
  });

  it('service/publish#upgrade: a policy that keeps reading allowedTeams plans no index change', () => {
    expect(plan(account(compare('allowedTeams', 'subsetOf')), account(compare('allowedTeams')))).toEqual([]);
  });

  it('service/publish#upgrade: a new Property that the policy reads gets the index in its create change', () => {
    const before = objectType('Account', 'account', 'accountId', [
      property('accountId', 'account_id', { kind: 'string' }, true),
      property('ownerId', 'owner_id', { kind: 'string' }),
    ]);

    const changes = plan(account(compare('allowedTeams')), before);

    expect(changes).toEqual([
      {
        description: 'Create Property allowedTeams of Object Type Account',
        statements: [expect.stringContaining('ADD COLUMN "allowed_teams" text[]'), CREATE_INDEX],
      },
    ]);
  });
});
