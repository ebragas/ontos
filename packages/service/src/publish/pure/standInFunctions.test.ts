import { describe, expect, it } from 'vitest';
import { standInFunctions } from './standInFunctions.ts';

const ir = {
  ontology: {
    actionTypes: {
      'close-account': {
        actionType: {
          actionTypeLogic: {
            logic: { rules: [{ type: 'functionRule', functionRule: { functionRid: 'closeAccount' } }] },
          },
        },
      },
    },
  },
};

describe('standInFunctions', () => {
  it('service/publish#route: each stand-in Function returns a list of ontologyEdit, so it is an edit Function', () => {
    expect(standInFunctions(ir)?.discovered).toEqual([
      {
        locator: { type: 'typescript', typescript: { functionName: 'closeAccount' } },
        inputs: [],
        output: {
          type: 'single',
          single: { dataType: { type: 'list', list: { elementsType: { type: 'ontologyEdit', ontologyEdit: {} } } } },
        },
        customTypes: {},
      },
    ]);
  });
});
