import type { DiscoveredFunction, PublishedFunctions } from '../index.ts';

export function standInFunctions(ir: unknown): PublishedFunctions | undefined {
  const names = new Set<string>();
  const actionTypes = field(field(ir, 'ontology'), 'actionTypes');

  if (typeof actionTypes !== 'object' || actionTypes === null) return undefined;

  for (const value of Object.values(actionTypes)) {
    const rules = field(field(field(field(value, 'actionType'), 'actionTypeLogic'), 'logic'), 'rules');

    if (!Array.isArray(rules)) continue;

    for (const rule of rules) {
      const functionRid = field(field(rule, 'functionRule'), 'functionRid');

      if (field(rule, 'type') === 'functionRule' && typeof functionRid === 'string') names.add(functionRid);
    }
  }

  if (names.size === 0) return undefined;

  const discovered = [...names].map((functionName): DiscoveredFunction => ({
    locator: { type: 'typescript', typescript: { functionName } },
    inputs: [],
    output: {
      type: 'single',
      single: { dataType: { type: 'list', list: { elementsType: { type: 'ontologyEdit', ontologyEdit: {} } } } },
    },
    customTypes: {},
  }));

  return { discovered, bundle: '' };
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}
