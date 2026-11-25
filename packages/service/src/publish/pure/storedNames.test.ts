import { describe, expect, it } from 'vitest';
import { type CompiledOntology } from '../../ontology/index.ts';
import { compileOrThrow, stored, twinFunctions, twinIr, type TwinVersion } from '../../ontology/stored.test-utils.ts';
import { storedNameKeys } from './storedNames.ts';

function compiledKeys(ontology: CompiledOntology): Set<string> {
  const keys = new Set<string>();

  for (const [type, objectType] of ontology.objectTypes) {
    keys.add(`objectType:${type}`);

    for (const property of objectType.properties.keys()) keys.add(`property:${type}:${property}`);

    for (const side of objectType.links.keys()) keys.add(`link:${type}:${side}`);
  }

  for (const link of ontology.linkTypes.keys()) keys.add(`linkType:${link}`);

  for (const action of ontology.actionTypes.keys()) keys.add(`actionType:${action}`);

  return keys;
}

describe('the API names of a stored IR', () => {
  it.each<TwinVersion>(['0.4.0', '0.6.3', '0.7.0'])(
    'ontology/object-edits/schema-migrations#edge-rules: the stored IR of twin %s gives the same name keys as its compiled Ontology',
    (version) => {
      const compiled = compileOrThrow(stored(twinIr(version), { functions: twinFunctions(version) }));

      expect(compiled.linkTypes.size).toBeGreaterThan(0);
      expect(compiled.actionTypes.size).toBeGreaterThan(0);
      expect([...storedNameKeys(twinIr(version))].sort()).toEqual([...compiledKeys(compiled)].sort());
    },
  );

  it('ontology/object-edits/schema-migrations#edge-rules: an IR with an unknown shape gives the names it can read, and never throws', () => {
    const ir = {
      ontology: {
        objectTypes: {
          a: null,
          b: { objectType: { apiName: 'ns.Account', propertyTypes: [1, 2] } },
          c: { objectType: { apiName: 7 } },
        },
        linkTypes: {
          x: { linkType: { id: 'account-to-engagements', definition: { type: 'intermediary', intermediary: {} } } },
          y: 'text',
        },
        actionTypes: 5,
      },
    };

    expect([...storedNameKeys(ir)]).toEqual(['objectType:ns.Account', 'linkType:accountToEngagements']);
    expect([...storedNameKeys(null)]).toEqual([]);
    expect([...storedNameKeys({ ontology: [] })]).toEqual([]);
  });
});
