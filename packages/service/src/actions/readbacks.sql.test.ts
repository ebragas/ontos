import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startActions, type ActionsService, type Answer } from './actions.test-utils.ts';
import { NS, twinFunctions, twinIr } from '../ontology/stored.test-utils.ts';

const STRUCT_PROBE = `${NS}StructProbe`;
const BEFORE = { label: 'before', since: '2020-01-01' };
const FN = { label: 'fn', since: '2026-02-03' };
const EXECUTE = { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'ALL_V2_WITH_DELETIONS' };

let service: ActionsService;
const applies = new Map<number, Answer>();
let probes: Map<string, Record<string, unknown>>;

const setRelationship = (probe: string, relationship: object | undefined, mode: string) =>
  service.apply(`${NS}set-relationship-action`, {
    parameters: { probe, ...(relationship ? { relationship } : {}), mode },
    options: EXECUTE,
  });

beforeAll(async () => {
  service = await startActions(twinIr('0.6.3'), twinFunctions('0.6.3'));

  for (const [probeId, relationship] of [
    ['sp-f1', BEFORE],
    ['sp-f2', BEFORE],
    ['sp-f3', BEFORE],
    ['sp-f4', BEFORE],
    ['sp-f5', BEFORE],
    ['sp-f7', BEFORE],
    ['sp-f6', undefined],
  ] as const) {
    const created = await service.apply(`${NS}create-struct-probe`, {
      parameters: { probeId, ...(relationship ? { relationship } : {}) },
      options: EXECUTE,
    });

    if (created.status !== 200)
      throw new Error(`The create of ${probeId} gave ${created.status}: ${JSON.stringify(created.body)}`);
  }

  applies.set(85, await setRelationship('sp-f1', FN, 'full'));

  applies.set(86, await setRelationship('sp-f2', FN, 'label-only'));

  applies.set(87, await setRelationship('sp-f3', FN, 'bad-date'));

  applies.set(88, await setRelationship('sp-f4', FN, 'extra-field'));

  applies.set(89, await setRelationship('sp-f5', FN, 'null'));

  applies.set(90, await setRelationship('sp-f6', FN, 'echo'));

  applies.set(91, await setRelationship('sp-f7', FN, 'echo'));

  applies.set(92, await setRelationship('sp-f1', { label: 'fn-no-since' }, 'full'));

  applies.set(93, await setRelationship('sp-f1', { since: '2026-02-03' }, 'full'));

  const loaded = await service.loadObjects({
    objectSet: { type: 'base', objectType: STRUCT_PROBE },
    select: [],
    pageSize: 1000,
  });

  if (loaded.status !== 200) throw new Error(`The read-back gave ${loaded.status}: ${JSON.stringify(loaded.body)}`);

  probes = new Map(
    (loaded.body as { data: Record<string, unknown>[] }).data.map((probe) => [probe['__primaryKey'] as string, probe]),
  );
});

afterAll(() => service?.stop());

const relationshipOf = (probeId: string) => {
  const probe = probes.get(probeId);

  if (!probe) throw new Error(`The read-back has no ${probeId}.`);

  return 'relationship' in probe ? probe['relationship'] : 'absent';
};

const valueError = (property: string) =>
  expect.objectContaining({
    status: 400,
    body: expect.objectContaining({
      errorCode: 'INVALID_ARGUMENT',
      errorName: 'ApplyActionFailed',
      parameters: expect.objectContaining({
        originalErrorName: 'Ontos:InvalidActionPropertyFormat',
        userErrorMessage: 'The Action could not apply because a Property value is invalid.',
        builderErrorMessage: 'The Function assigned a value whose type does not match the Property.',
        objectType: STRUCT_PROBE,
        property,
      }),
    }),
  });

describe('the read-backs of Function struct edits', () => {
  it('sp-f2: a Function edit writes the whole struct, so a field that it does not write is absent', () => {
    expect(applies.get(86)?.status).toBe(200);
    expect(relationshipOf('sp-f2')).toEqual({ label: 'fn' });
  });

  it('sp-f1: a Function edit with a struct that has no since stores the struct with no since', () => {
    expect([applies.get(85)?.status, applies.get(92)?.status]).toEqual([200, 200]);
    expect(relationshipOf('sp-f1')).toEqual({ label: 'fn-no-since' });
  });

  it(
    'ontology/action-types/action-types#parameters: a struct parameter with no required field label gets 400 InvalidParameterValue, ' +
      'and the Function does not run, so sp-f1 keeps its struct',
    () => {
      expect(applies.get(93)).toEqual(
        expect.objectContaining({
          status: 400,
          body: expect.objectContaining({
            errorName: 'InvalidParameterValue',
            parameters: expect.objectContaining({ parameterId: 'relationship' }),
          }),
        }),
      );

      expect(relationshipOf('sp-f1')).toEqual({ label: 'fn-no-since' });
    },
  );

  it(
    'service/http-api#errors: sp-f3, a Function edit with a bad date fails with the Function builderErrorMessage, ' +
      'and leaves the stored struct as it was',
    () => {
      expect(applies.get(87)).toEqual(valueError('relationship.since'));
      expect(relationshipOf('sp-f3')).toEqual(BEFORE);
    },
  );

  it(
    'service/http-api#errors: sp-f4, a Function edit with an unknown struct field gets 400 ApplyActionFailed, ' +
      'and the struct does not change',
    () => {
      expect(applies.get(88)).toEqual(valueError('relationship.unknown'));
      expect(relationshipOf('sp-f4')).toEqual(BEFORE);
    },
  );

  it('ontology/object-link-types/properties#structs: sp-f5, a Function edit that sets a struct to null removes the key on read', () => {
    expect(applies.get(89)?.status).toBe(200);
    expect(relationshipOf('sp-f5')).toBe('absent');
  });

  it('ontology/object-link-types/properties#structs: sp-f6, a Function reads an unset struct as {}', () => {
    expect(applies.get(90)?.status).toBe(200);
    expect(relationshipOf('sp-f6')).toEqual({ label: 'echo: {}', since: '2026-02-03' });
  });

  it('sp-f7: a Function reads the stored struct values', () => {
    expect(applies.get(91)?.status).toBe(200);

    expect(relationshipOf('sp-f7')).toEqual({
      label: 'echo: {"label":"before","since":"2020-01-01"}',
      since: '2026-02-03',
    });
  });
});
