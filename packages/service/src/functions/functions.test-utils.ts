import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { OntologyIr } from '@osdk/client.unstable';
import { build, type Plugin } from 'esbuild';
import type { Edit } from '../actions/index.ts';
import type { DiscoveredFunction, PublishedFunctions } from '../publish/index.ts';
import { manyToManyLink } from '../actions/actions.test-utils.ts';
import { NS, twinFunctions, twinIr, unchecked } from '../ontology/stored.test-utils.ts';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

const dropFs: Plugin = {
  name: 'drop-fs',
  setup(b) {
    b.onResolve({ filter: /^fs$/ }, () => ({ path: 'fs', external: true, sideEffects: false }));
  },
};

export async function bundle(source: string): Promise<string> {
  const ownClient = /export const createClient\b/.test(source);

  const result = await build({
    stdin: {
      contents: ownClient ? source : `${source}\nexport { createClient } from '@osdk/client';`,
      resolveDir: ROOT,
      sourcefile: 'functions.ts',
      loader: 'ts',
    },
    absWorkingDir: ROOT,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2024',
    plugins: [dropFs],
    write: false,
    logLevel: 'silent',
  });

  const [output] = result.outputFiles;

  if (!output) throw new Error('esbuild wrote no bundle.');

  return output.text;
}

type ScalarType = 'string' | 'integer' | 'boolean' | 'decimal';

export interface TestField {
  readonly name: string;
  readonly type: 'string' | 'integer' | 'boolean' | 'double' | 'decimal' | 'date' | 'timestamp';
  readonly required: boolean;
  readonly decimal?: { readonly precision: number; readonly scale: number };
}

export type TestInput =
  | {
      readonly name: string;
      readonly type: ScalarType | 'stringList' | 'decimalList';
      readonly required?: false;
      readonly allowedValues?: readonly string[];
    }
  | {
      readonly name: string;
      readonly type: 'object' | 'objectList';
      readonly objectType: string;
      readonly required?: false;
    }
  | {
      readonly name: string;
      readonly type: 'struct' | 'structList';
      readonly fields: readonly TestField[];
      readonly required?: false;
    };

export interface TestFunction {
  readonly apiName: string;
  readonly inputs: readonly TestInput[];
  readonly edits: readonly string[];
  readonly links?: readonly string[];
}

function dataTypeOf(input: TestInput): object {
  if (input.type === 'object') return { type: 'object', object: { objectTypeId: input.objectType } };

  if (input.type === 'objectList')
    return { type: 'list', list: { elementsType: { type: 'object', object: { objectTypeId: input.objectType } } } };

  if (input.type === 'stringList') return { type: 'list', list: { elementsType: { type: 'string', string: {} } } };

  if (input.type === 'decimalList') return { type: 'list', list: { elementsType: { type: 'decimal', decimal: {} } } };

  if (input.type === 'struct') return { type: 'functionCustomType', functionCustomType: input.name };

  if (input.type === 'structList') {
    const list = {
      type: 'list',
      list: { elementsType: { type: 'functionCustomType', functionCustomType: input.name } },
    };

    return input.required === false ? { type: 'optionalType', optionalType: { wrappedType: list } } : list;
  }

  return { type: input.type, [input.type]: {} };
}

function customTypesOf(inputs: readonly TestInput[]): Record<string, object> {
  const structs = inputs.filter(
    (input): input is Extract<TestInput, { fields: unknown }> => input.type === 'struct' || input.type === 'structList',
  );

  return Object.fromEntries(
    structs.map(({ name, fields }) => [
      name,
      {
        fields: Object.fromEntries(
          fields.map((field) => {
            const type = { type: field.type, [field.type]: field.decimal ?? {} };

            return [field.name, field.required ? type : { type: 'optionalType', optionalType: { wrappedType: type } }];
          }),
        ),
        fieldMetadata: Object.fromEntries(fields.map((field) => [field.name, { required: field.required }])),
      },
    ]),
  );
}

export const actionOf = (apiName: string): string =>
  `${NS}fn-${apiName.replaceAll(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;

export async function withFunctions(
  functions: readonly TestFunction[],
  source: string,
  base: OntologyIr = twinIr('0.6.3'),
): Promise<{ ir: OntologyIr; functions: PublishedFunctions }> {
  const ir = structuredClone(base);
  const template = twinIr('0.6.3').ontology.actionTypes[`${NS}close-account-action`];

  if (!template) throw new Error('The twin 0.6.3 IR has no close-account-action.');

  const discovered: DiscoveredFunction[] = [...twinFunctions('0.6.3').discovered];

  for (const fn of functions) {
    const action = structuredClone(template);

    action.actionType.metadata.apiName = actionOf(fn.apiName);

    const [rule] = action.actionType.actionTypeLogic.logic.rules;

    if (rule?.type !== 'functionRule') throw new Error('The close-account-action of the twin has no Function rule.');

    rule.functionRule.functionRid = fn.apiName;

    ir.ontology.actionTypes[actionOf(fn.apiName)] = action;

    discovered.push(
      unchecked<DiscoveredFunction>({
        locator: { type: 'typescript', typescript: { functionName: fn.apiName } },
        inputs: [
          { name: 'client', dataType: { type: 'client', client: {} } },
          ...fn.inputs.map((input) => ({
            name: input.name,
            dataType: dataTypeOf(input),
            ...(input.required === false ? { required: false } : {}),
            ...('allowedValues' in input && input.allowedValues ? { allowedValues: input.allowedValues } : {}),
          })),
        ],
        output: {
          single: { dataType: { type: 'list', list: { elementsType: { type: 'ontologyEdit', ontologyEdit: {} } } } },
        },
        customTypes: customTypesOf(fn.inputs),
        ontologyProvenance: {
          editedObjects: Object.fromEntries(fn.edits.map((objectType) => [objectType, {}])),
          editedLinks: Object.fromEntries((fn.links ?? []).map((linkType) => [linkType, {}])),
          editedInterfaces: {},
        },
      }),
    );
  }

  return { ir, functions: { discovered, bundle: await bundle(source) } };
}

const ACCOUNT = `${NS}Account`;
const ENGAGEMENT = `${NS}Engagement`;

export function editsIr(): OntologyIr {
  const ir = twinIr('0.6.3');

  for (const objectType of [ACCOUNT, ENGAGEMENT]) {
    const block = ir.ontology.objectTypes[objectType];

    if (!block) throw new Error(`The twin 0.6.3 IR has no ${objectType}.`);

    block.entityMetadata = unchecked({
      ...block.entityMetadata,
      editsHistory: { type: 'config', config: { store: objectType, storeAllPreviousProperties: false } },
    });
  }

  const sponsors = manyToManyLink(
    'engagement-sponsors',
    { type: ENGAGEMENT, key: 'engagementId', side: 'sponsors' },
    { type: ACCOUNT, key: 'accountId', side: 'sponsoredEngagements' },
  );

  ir.ontology.linkTypes[sponsors.linkType.id] = sponsors;

  return ir;
}

export class ScriptedUserFacingError extends Error {}

export interface ScriptedRun {
  readonly args: readonly unknown[];
  readonly read?: unknown;
}

export type ScriptedAnswer = (run: ScriptedRun) => readonly Edit[] | Promise<readonly Edit[]>;

export class ScriptedFunctions {
  readonly source: string;
  #runs = 0;
  #once: ScriptedAnswer[] = [];
  #always: ScriptedAnswer | undefined;
  readonly #channel: BroadcastChannel;
  readonly #primaryKeys: ReadonlyMap<string, string>;

  constructor(ir: OntologyIr, functions = '') {
    const name = `scripted-functions-${randomUUID()}`;

    this.#primaryKeys = new Map(
      Object.entries(ir.ontology.objectTypes).flatMap(([apiName, block]) => {
        const [key] = block.objectType.primaryKeys;

        return key === undefined ? [] : [[apiName, key] as const];
      }),
    );

    this.#channel = new BroadcastChannel(name);

    this.#channel.unref();

    this.#channel.onmessage = ({ data }: { data: { kind: string; id: string; run: ScriptedRun } }) => {
      if (data.kind === 'run') void this.#answer(data.id, data.run);
    };

    this.source = `
import { createEditBatch, UserFacingError } from '@osdk/functions';

const ref = (object) => ({ $apiName: object.objectType, $primaryKey: object.primaryKey });

async function answer(client, run) {
  const channel = new BroadcastChannel('${name}');
  const id = crypto.randomUUID();
  try {
    const answered = await new Promise((resolve) => {
      channel.onmessage = ({ data }) => { if (data.kind === 'answer' && data.id === id) resolve(data); };
      channel.postMessage({ kind: 'run', id, run: JSON.parse(JSON.stringify(run)) });
    });
    if (answered.error !== undefined) throw answered.userFacing ? new UserFacingError(answered.error) : new Error(answered.error);
    const batch = createEditBatch(client);
    for (const edit of answered.edits) {
      if (edit.type === 'addObject') batch.create({ type: 'object', apiName: edit.object.objectType }, { [edit.key]: edit.object.primaryKey, ...edit.properties });
      else if (edit.type === 'modifyObject') batch.update(ref(edit.object), edit.properties);
      else if (edit.type === 'deleteObject') batch.delete(ref(edit.object));
      else if (edit.type === 'addLink') batch.link(ref(edit.source), edit.link, ref(edit.target));
      else batch.unlink(ref(edit.source), edit.link, ref(edit.target));
    }
    return batch.getEdits();
  } finally {
    channel.close();
  }
}

export const functions = {
  scripted: (client, ...args) => answer(client, { args }),
  ${functions}
};
`;
  }

  get runs(): number {
    return this.#runs;
  }

  once(answer: ScriptedAnswer): void {
    this.#once.push(answer);
  }

  always(answer: ScriptedAnswer): void {
    this.#always = answer;
  }

  reset(): void {
    this.#once = [];
    this.#always = undefined;
    this.#runs = 0;
  }

  close(): void {
    this.#channel.close();
  }

  async #answer(id: string, run: ScriptedRun): Promise<void> {
    this.#runs += 1;

    const answer = this.#once.shift() ?? this.#always;

    try {
      if (!answer) throw new Error('The test did not expect a Function run.');

      const edits = (await answer(run)).map((edit) => {
        if (edit.type === 'addObject')
          return {
            ...edit,
            key: this.#primaryKeys.get(edit.object.objectType),
            properties: Object.fromEntries(edit.properties),
          };

        return 'properties' in edit ? { ...edit, properties: Object.fromEntries(edit.properties) } : edit;
      });

      this.#channel.postMessage({ kind: 'answer', id, edits });
    } catch (error) {
      this.#channel.postMessage({
        kind: 'answer',
        id,
        error: error instanceof Error ? error.message : String(error),
        userFacing: error instanceof ScriptedUserFacingError,
      });
    }
  }
}
