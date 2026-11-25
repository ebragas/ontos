import type { OntologyIr } from '@osdk/client.unstable';
import { NS, stringProperty, twinIr, unchecked } from '../ontology/stored.test-utils.ts';
import { withFunctions, type TestField, type TestFunction } from './functions.test-utils.ts';

export const ROW_PROBE = `${NS}RowProbe`;

export const ROW: readonly TestField[] = [
  { name: 'rowId', type: 'string', required: true },
  { name: 'label', type: 'string', required: true },
  { name: 'count', type: 'integer', required: true },
  { name: 'note', type: 'string', required: false },
  { name: 'op', type: 'string', required: true },
];

const TYPED_ROW: readonly TestField[] = [
  { name: 'amount', type: 'double', required: true },
  { name: 'flag', type: 'boolean', required: true },
  { name: 'postedOn', type: 'date', required: true },
  { name: 'at', type: 'timestamp', required: true },
];

export const FUNCTIONS: readonly TestFunction[] = [
  {
    apiName: 'applyRowProbes',
    inputs: [
      { name: 'rows', type: 'structList', fields: ROW },
      { name: 'reportId', type: 'string', required: false },
    ],
    edits: [ROW_PROBE],
  },
  {
    apiName: 'applyOptionalRows',
    inputs: [
      { name: 'rows', type: 'structList', fields: ROW, required: false },
      { name: 'reportId', type: 'string', required: false },
    ],
    edits: [ROW_PROBE],
  },
  {
    apiName: 'reportTypes',
    inputs: [
      { name: 'reportId', type: 'string' },
      { name: 'rows', type: 'structList', fields: TYPED_ROW },
    ],
    edits: [ROW_PROBE],
  },
];

export const SOURCE = `
import { createEditBatch } from '@osdk/functions';

const RowProbe = { type: 'object', apiName: '${ROW_PROBE}' };
const ref = (rowId) => ({ $apiName: '${ROW_PROBE}', $primaryKey: rowId });

async function applyRowProbes(client, rows, reportId) {
  const batch = createEditBatch(client);
  for (const { rowId, label, count, note, op } of rows) {
    if (op === 'create') batch.create(RowProbe, { rowId, label, count, note });
    if (op === 'update') batch.update(ref(rowId), { label, count, note });
    if (op === 'delete') batch.delete(ref(rowId));
  }
  if (reportId !== undefined) {
    const label = JSON.stringify({
      rows: Array.isArray(rows) ? rows.length : String(rows),
      note: Array.isArray(rows) ? rows.map((row) => (Object.hasOwn(row, 'note') ? typeof row.note : 'absent')) : null,
    });
    batch.create(RowProbe, { rowId: reportId, label });
  }
  return batch.getEdits();
}

export const functions = {
  applyRowProbes,
  applyOptionalRows: applyRowProbes,
  reportTypes: async (client, reportId, rows) => {
    const batch = createEditBatch(client);
    const label = JSON.stringify(rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, \`\${typeof value}:\${JSON.stringify(value)}\`]))));
    batch.create(RowProbe, { rowId: reportId, label });
    return batch.getEdits();
  },
};
`;

export function rowProbeIr(): OntologyIr {
  const ir = twinIr('0.6.3');
  const account = ir.ontology.objectTypes[`${NS}Account`];

  if (!account) throw new Error('The twin 0.6.3 IR has no Account.');

  const block = structuredClone(account);

  const properties = {
    rowId: stringProperty('rowId'),
    label: stringProperty('label'),
    count: {
      ...stringProperty('count'),
      type: unchecked<(typeof account.objectType.propertyTypes)[string]['type']>({ type: 'integer', integer: {} }),
    },
    note: stringProperty('note'),
  };

  block.objectType = {
    ...block.objectType,
    apiName: ROW_PROBE,
    displayMetadata: { ...block.objectType.displayMetadata, displayName: 'Row probe', pluralDisplayName: 'Row probes' },
    primaryKeys: ['rowId'],
    titlePropertyTypeRid: 'label',
    propertyTypes: properties,
  };

  block.datasources = [
    {
      ...block.datasources[0],
      datasourceName: ROW_PROBE,
      datasource: {
        type: 'datasetV2',
        datasetV2: {
          datasetRid: ROW_PROBE,
          propertyMapping: Object.fromEntries(
            Object.keys(properties).map((name) => [name, { type: 'column', column: name }]),
          ),
        },
      },
    } as (typeof block.datasources)[number],
  ];

  block.entityMetadata = unchecked({
    ...block.entityMetadata,
    editsHistory: { type: 'config', config: { store: ROW_PROBE, storeAllPreviousProperties: false } },
  });

  ir.ontology.objectTypes[ROW_PROBE] = block;

  return ir;
}

export function structListOntology(): ReturnType<typeof withFunctions> {
  return withFunctions(FUNCTIONS, SOURCE, rowProbeIr());
}
