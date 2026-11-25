import type { OntologyIrObjectTypeBlockDataV2 } from '@osdk/client.unstable';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from '../db/index.ts';
import { irOf, propertyOfType, STRING_FLAGS, twinBlock } from '../ontology/stored.test-utils.ts';
import { sql } from '../publish/publish.test-utils.ts';
import {
  errorAnswer,
  expectAggregate,
  insertObjects,
  NS,
  pageOf,
  startObjectSets,
  type Answer,
  type ObjectRow,
  type ObjectSetsService,
} from './objectSets.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const STRUCT_PROBE = `${NS}StructProbe`;

function accountBlock(): OntologyIrObjectTypeBlockDataV2 {
  const block = twinBlock('0.7.0', ACCOUNT);

  block.objectType.propertyTypes['tags'] = propertyOfType('tags', {
    type: 'array',
    array: { subtype: { type: 'string', string: STRING_FLAGS }, reducers: [] },
  });

  return block;
}

let service: ObjectSetsService;

beforeAll(async () => {
  service = await startObjectSets(irOf(accountBlock(), twinBlock('0.7.0', STRUCT_PROBE)));
});

afterAll(() => service?.stop());

beforeEach(() => service.clear());

const NAME: Readonly<Record<string, string>> = {
  'acc-1': 'Acme',
  'acc-2': 'Globex',
  'acc-3': 'Initech',
  'p-t-apos': "O'Brien",
  'p-t-hyphen': 'e-mail',
  'p-t-dot': 'foo.bar',
  'p-t-alnum': 'ABC123',
  'p-t-accent': 'café',
  'p-t-case': 'MiXeD Case',
  'p-t-ja': '東京タワー',
  'p-t-zh': '中华人民共和国',
  'p-t-words': 'Acme Corp Holdings',
  'p-t-under': 'hello_world',
  'p-s-01': '10',
  'p-s-02': '9',
  'p-s-03': '1abc',
  'p-s-04': 'ABC',
  'p-s-05': 'Abc',
  'p-s-06': 'abc',
  'p-s-07': 'ebc',
  'p-s-08': 'Ébc',
  'p-s-09': 'ébc',
  'p-s-10': 'Zed',
  'p-s-11': 'zed',
  'p-s-12': '_x',
  'p-s-13': 'Ölm',
  'p-s-14': '日本',
  'p-s-15': 'Ωmega',
  'p-x-under': 'a_c',
  'p-x-dot': 'fooxbar',
};

const RID: Readonly<Record<string, string>> = {
  'acc-1': 'ri.phonograph2-objects.main.object.8d7bec66-1177-57d5-8311-9617d1f43aa2',
  'acc-2': 'ri.phonograph2-objects.main.object.8f164048-7dab-5f42-97d1-76399da06441',
  'acc-3': 'ri.phonograph2-objects.main.object.03aae71d-fb1a-5e2f-b568-f696aaf1576a',
  'p-t-apos': 'ri.phonograph2-objects.main.object.b5e618bd-af06-5cb0-bcbb-e88740bdf136',
  'p-t-hyphen': 'ri.phonograph2-objects.main.object.60b04aab-dc7a-5ade-89ec-aa450209a2ea',
  'p-t-dot': 'ri.phonograph2-objects.main.object.b4c2c389-50fb-54ef-9be1-2f8280d64b2c',
  'p-t-alnum': 'ri.phonograph2-objects.main.object.bb586883-ddd5-5953-9e46-824513b6f143',
  'p-t-accent': 'ri.phonograph2-objects.main.object.1e2361e1-81de-527d-af60-d50c04efc94d',
  'p-t-case': 'ri.phonograph2-objects.main.object.6a6b93b9-2db1-5b08-b991-a5543989a3e6',
  'p-t-ja': 'ri.phonograph2-objects.main.object.b8594f02-395b-58da-a2e0-7c11cbef23c4',
  'p-t-zh': 'ri.phonograph2-objects.main.object.1cd4f729-f8ca-586f-81fb-90459868dfd5',
  'p-t-words': 'ri.phonograph2-objects.main.object.e4ad94d9-c5d3-58e1-84aa-1323cf3f527d',
  'p-t-under': 'ri.phonograph2-objects.main.object.c5886e8a-e7f6-533d-8fde-180407c3b6c6',
  'p-s-01': 'ri.phonograph2-objects.main.object.8135ec0a-1d6c-5d2e-b911-715f79ec5f7e',
  'p-s-02': 'ri.phonograph2-objects.main.object.10efa5f1-f54b-55ca-865e-f911bbcc8c8e',
  'p-s-03': 'ri.phonograph2-objects.main.object.3668b147-0f34-5259-8c23-95106b46b4b2',
  'p-s-04': 'ri.phonograph2-objects.main.object.5a48d50d-bf7f-5a37-9c62-16a1b0bb9952',
  'p-s-05': 'ri.phonograph2-objects.main.object.cdb6071c-5334-5cff-8cc5-182d4edbcdce',
  'p-s-06': 'ri.phonograph2-objects.main.object.9aa4c761-a757-53ce-a01e-158a22e31db0',
  'p-s-07': 'ri.phonograph2-objects.main.object.52ebdf1c-965e-5d14-85fb-a2eb756b3b53',
  'p-s-08': 'ri.phonograph2-objects.main.object.8ba5f5d3-211f-559f-9ba3-d64a347594b3',
  'p-s-09': 'ri.phonograph2-objects.main.object.ff9d973d-5cb9-5c8d-95dc-4199028e340e',
  'p-s-10': 'ri.phonograph2-objects.main.object.5906c0a8-daf4-5c45-b531-5e0641fd320d',
  'p-s-11': 'ri.phonograph2-objects.main.object.82387c01-ebb1-5ae7-a037-2a484ff78cb2',
  'p-s-12': 'ri.phonograph2-objects.main.object.83cff43c-8a37-5f22-ac0b-17f3dc055cfa',
  'p-s-13': 'ri.phonograph2-objects.main.object.c0c75642-ab89-5b98-8729-6fb12038dd7e',
  'p-s-14': 'ri.phonograph2-objects.main.object.291fb5c4-caf7-543f-8895-43c787e4431c',
  'p-s-15': 'ri.phonograph2-objects.main.object.39f716fb-daa0-55ff-a4d3-51eb6dd92dc5',
  'p-x-under': 'ri.phonograph2-objects.main.object.f5bb06e6-15fa-5a2c-9b10-78ebe0c78163',
  'p-x-dot': 'ri.phonograph2-objects.main.object.f9232d75-369e-5e62-b197-fb8912e578e8',
};

const PHASE: Readonly<Record<string, string>> = { 'acc-1': 'customer', 'acc-2': 'prospect', 'acc-3': 'closed' };

const accountRow = (accountId: string): ObjectRow => ({
  accountId,
  name: NAME[accountId] ?? null,
  phase: PHASE[accountId] ?? null,
});

const TEXT_ACCOUNTS: readonly ObjectRow[] = [
  'acc-1',
  'acc-2',
  'acc-3',
  'p-t-apos',
  'p-t-hyphen',
  'p-t-dot',
  'p-t-alnum',
  'p-t-accent',
  'p-t-case',
  'p-t-ja',
  'p-t-zh',
  'p-t-words',
  'p-t-under',
  'p-s-01',
  'p-s-02',
  'p-s-03',
  'p-s-04',
  'p-s-05',
  'p-s-06',
  'p-s-07',
  'p-s-08',
  'p-s-09',
  'p-s-10',
  'p-s-11',
  'p-s-12',
  'p-s-13',
  'p-s-14',
  'p-s-15',
].map(accountRow);

const named = (accountId: string) => ({
  name: NAME[accountId],
  __title: NAME[accountId],
  accountId,
  __primaryKey: accountId,
  __apiName: ACCOUNT,
  __rid: RID[accountId],
});

const textSearch = (where: Readonly<Record<string, unknown>>) => ({
  objectSet: { type: 'filter', objectSet: { type: 'base', objectType: ACCOUNT }, where },
  select: ['name'],
  orderBy: { fields: [{ field: 'accountId', direction: 'asc' }] },
});

const answerWith = (primaryKeys: readonly string[]): Answer => ({
  status: 200,
  body: {
    data: primaryKeys.map(named),
    totalCount: String(primaryKeys.length),
    propertySecurities: [],
    objectSetEntities: { objectTypeApiNames: [ACCOUNT] },
  },
});

describe('text searches on the 28 Accounts', () => {
  it('ontology/ontology-sdk/object-sets#objects-in-a-page ontology/ontology-sdk/object-sets#text-search: containsAnyTerm name "acme" with a select of the title Property name', async () => {
    await insertObjects(service.db, ACCOUNT, TEXT_ACCOUNTS);

    const answer = await service.loadObjects({
      objectSet: {
        type: 'filter',
        objectSet: { type: 'base', objectType: ACCOUNT },
        where: { type: 'containsAnyTerm', field: 'name', value: 'acme' },
      },
      select: ['name'],
      orderBy: { fields: [{ field: 'accountId', direction: 'asc' }] },
    });

    expect(answer).toEqual({
      status: 200,
      body: {
        data: [
          {
            name: 'Acme',
            __title: 'Acme',
            accountId: 'acc-1',
            __primaryKey: 'acc-1',
            __apiName: ACCOUNT,
            __rid: 'ri.phonograph2-objects.main.object.8d7bec66-1177-57d5-8311-9617d1f43aa2',
          },
          {
            name: 'Acme Corp Holdings',
            __title: 'Acme Corp Holdings',
            accountId: 'p-t-words',
            __primaryKey: 'p-t-words',
            __apiName: ACCOUNT,
            __rid: 'ri.phonograph2-objects.main.object.e4ad94d9-c5d3-58e1-84aa-1323cf3f527d',
          },
        ],
        totalCount: '2',
        propertySecurities: [],
        objectSetEntities: { objectTypeApiNames: [ACCOUNT] },
      },
    });
  });

  it.each([
    ["o'brien", ['p-t-apos']],
    ['brien', []],
    ['o', []],
    ['e-mail', ['p-t-hyphen']],
    ['mail', ['p-t-hyphen']],
    ['e', ['p-t-hyphen']],
    ['foo.bar', ['p-t-dot']],
    ['foo', []],
    ['bar', []],
    ['abc123', ['p-t-alnum']],
    ['abc', ['p-s-04', 'p-s-05', 'p-s-06']],
    ['123', []],
    ['café', ['p-t-accent']],
    ['cafe', []],
    ['mixed', ['p-t-case']],
    ['CASE', ['p-t-case']],
    ['東京タワー', ['p-t-ja']],
    ['東京', ['p-t-ja']],
    ['東', ['p-t-ja']],
    ['タワー', ['p-t-ja']],
    ['中华人民共和国', ['p-t-zh']],
    ['中华', ['p-t-zh']],
    ['中', ['p-t-zh']],
    ['hello_world', ['p-t-under']],
    ['hello', []],
    ['globex initech', ['acc-2', 'acc-3']],
  ] as const)(
    'ontology/ontology-sdk/object-sets#text-search: containsAnyTerm name "%s"',
    async (value, primaryKeys) => {
      await insertObjects(service.db, ACCOUNT, TEXT_ACCOUNTS);

      const answer = await service.loadObjects(textSearch({ type: 'containsAnyTerm', field: 'name', value }));

      expect(answer).toEqual(answerWith(primaryKeys));
    },
  );

  it.each([
    ['holdings acme', ['p-t-words']],
    ['acme zzz', []],
    ['e mail', ['p-t-hyphen']],
    ['foo bar', []],
    ['o brien', []],
  ] as const)(
    'ontology/ontology-sdk/object-sets#text-search: containsAllTerms name "%s"',
    async (value, primaryKeys) => {
      await insertObjects(service.db, ACCOUNT, TEXT_ACCOUNTS);

      const answer = await service.loadObjects(textSearch({ type: 'containsAllTerms', field: 'name', value }));

      expect(answer).toEqual(answerWith(primaryKeys));
    },
  );

  it.each([
    ['acme corp', ['p-t-words']],
    ['acme holdings', []],
    ['corp acme', []],
    ['e mail', ['p-t-hyphen']],
    ['e-mail', ['p-t-hyphen']],
    ['foo bar', []],
    ['foo.bar', ['p-t-dot']],
    ['東京', ['p-t-ja']],
  ] as const)(
    'ontology/ontology-sdk/object-sets#text-search: containsAllTermsInOrder name "%s"',
    async (value, primaryKeys) => {
      await insertObjects(service.db, ACCOUNT, TEXT_ACCOUNTS);

      const answer = await service.loadObjects(textSearch({ type: 'containsAllTermsInOrder', field: 'name', value }));

      expect(answer).toEqual(answerWith(primaryKeys));
    },
  );

  it.each([
    ['Acme', ['acc-1', 'p-t-words']],
    ['acm', ['acc-1', 'p-t-words']],
    ['Acme Co', ['p-t-words']],
    ['acme co', ['p-t-words']],
    ['Cor', ['p-t-words']],
    ['corp hold', ['p-t-words']],
    ['hold', ['p-t-words']],
    ["O'Br", ['p-t-apos']],
    ['Bri', []],
    ['e-ma', ['p-t-hyphen']],
    ['mai', ['p-t-hyphen']],
    ['foo.b', ['p-t-dot']],
    ['ba', []],
    ['東', ['p-t-ja']],
    ['タ', ['p-t-ja']],
  ] as const)('ontology/ontology-sdk/object-sets#text-search: startsWith name "%s"', async (value, primaryKeys) => {
    await insertObjects(service.db, ACCOUNT, TEXT_ACCOUNTS);

    const answer = await service.loadObjects(textSearch({ type: 'startsWith', field: 'name', value }));

    expect(answer).toEqual(answerWith(primaryKeys));
  });

  it.each([
    ['Acme', ['acc-1', 'p-t-words']],
    ['acm', ['acc-1', 'p-t-words']],
    ['Acme Co', ['p-t-words']],
    ['acme co', ['p-t-words']],
    ['Cor', ['p-t-words']],
    ['corp hold', ['p-t-words']],
    ['hold', ['p-t-words']],
    ["O'Br", ['p-t-apos']],
    ['Bri', []],
    ['e-ma', ['p-t-hyphen']],
    ['mai', ['p-t-hyphen']],
    ['foo.b', ['p-t-dot']],
    ['ba', []],
    ['東', ['p-t-ja']],
    ['タ', ['p-t-ja']],
  ] as const)(
    'ontology/ontology-sdk/object-sets#text-search: containsAllTermsInOrderPrefixLastTerm name "%s"',
    async (value, primaryKeys) => {
      await insertObjects(service.db, ACCOUNT, TEXT_ACCOUNTS);

      const answer = await service.loadObjects(
        textSearch({ type: 'containsAllTermsInOrderPrefixLastTerm', field: 'name', value }),
      );

      expect(answer).toEqual(answerWith(primaryKeys));
    },
  );
});

describe('word boundary rules', () => {
  it.each([
    ['ÉBC', ['p-s-08', 'p-s-09']],
    ['ölm', ['p-s-13']],
    ['ωMEGA', ['p-s-15']],
  ] as const)(
    'ontology/ontology-sdk/object-sets#text-search: containsAnyTerm name "%s" ignores the case of a letter that is not ASCII, and removes no accent',
    async (value, primaryKeys) => {
      await insertObjects(service.db, ACCOUNT, TEXT_ACCOUNTS);

      const answer = await service.loadObjects(textSearch({ type: 'containsAnyTerm', field: 'name', value }));

      expect(answer).toEqual(answerWith(primaryKeys));
    },
  );

  it.each([
    ['ΟΣ', ['p-g-medial', 'p-g-upper']],
    ['οσ', ['p-g-medial', 'p-g-upper']],
    ['ος', ['p-g-final']],
  ] as const)(
    'ontology/ontology-sdk/object-sets#text-search: containsAnyTerm name "%s" matches each value whose letters have the same lower case',
    async (value, primaryKeys) => {
      await insertObjects(service.db, ACCOUNT, [
        { accountId: 'p-g-upper', name: 'ΟΣ' },
        { accountId: 'p-g-medial', name: 'οσ' },
        { accountId: 'p-g-final', name: 'ος' },
      ]);

      const answer = await service.loadObjects({
        ...textSearch({ type: 'containsAnyTerm', field: 'name', value }),
        excludeRid: true,
      });

      const body = answer.body as { data?: readonly { __primaryKey?: unknown }[] };

      expect({ status: answer.status, primaryKeys: body.data?.map((object) => object.__primaryKey) }).toEqual({
        status: 200,
        primaryKeys,
      });
    },
  );

  it.each([
    ['ß', ['p-l-sharp', 'p-l-sharp-upper']],
    ['ẞ', ['p-l-sharp', 'p-l-sharp-upper']],
    ['k', ['p-l-k', 'p-l-k-kelvin', 'p-l-k-upper']],
    ['K', ['p-l-k', 'p-l-k-kelvin', 'p-l-k-upper']],
    ['\u212a', ['p-l-k', 'p-l-k-kelvin', 'p-l-k-upper']],
  ] as const)(
    'ontology/ontology-sdk/object-sets#text-search: containsAnyTerm name "%s" matches each value whose letter has the same 1-character lower case',
    async (value, primaryKeys) => {
      await insertObjects(service.db, ACCOUNT, [
        { accountId: 'p-l-sharp', name: 'ß' },
        { accountId: 'p-l-sharp-upper', name: 'ẞ' },
        { accountId: 'p-l-k', name: 'k' },
        { accountId: 'p-l-k-upper', name: 'K' },
        { accountId: 'p-l-k-kelvin', name: '\u212a' },
      ]);

      const answer = await service.loadObjects({
        ...textSearch({ type: 'containsAnyTerm', field: 'name', value }),
        excludeRid: true,
      });

      const body = answer.body as { data?: readonly { __primaryKey?: unknown }[] };

      expect({ status: answer.status, primaryKeys: body.data?.map((object) => object.__primaryKey) }).toEqual({
        status: 200,
        primaryKeys,
      });
    },
  );

  it.each([
    ['\u0130stanbul', ['p-l-i-dot', 'p-l-i-plain']],
    ['istanbul', ['p-l-i-dot', 'p-l-i-plain']],
    ['ISTANBUL', ['p-l-i-dot', 'p-l-i-plain']],
    ['\u0131stanbul', ['p-l-i-dotless']],
  ] as const)(
    'ontology/ontology-sdk/object-sets#text-search: containsAnyTerm name "%s" folds \u0130 to i, as the simple lower case of Unicode does',
    async (value, primaryKeys) => {
      await insertObjects(service.db, ACCOUNT, [
        { accountId: 'p-l-i-dot', name: '\u0130stanbul' },
        { accountId: 'p-l-i-plain', name: 'istanbul' },
        { accountId: 'p-l-i-dotless', name: '\u0131stanbul' },
      ]);

      const answer = await service.loadObjects({
        ...textSearch({ type: 'containsAnyTerm', field: 'name', value }),
        excludeRid: true,
      });

      const body = answer.body as { data?: readonly { __primaryKey?: unknown }[] };

      expect({ status: answer.status, primaryKeys: body.data?.map((object) => object.__primaryKey) }).toEqual({
        status: 200,
        primaryKeys,
      });
    },
  );

  it.each([
    ['containsAnyTerm', 'a_c', ['p-x-under']],
    ['containsAnyTerm', 'foo.bar', ['p-t-dot']],
    ['containsAllTermsInOrder', 'foo.bar', ['p-t-dot']],
    ['startsWith', 'foo.b', ['p-t-dot']],
    ['startsWith', 'a_c', ['p-x-under']],
  ] as const)(
    'ontology/ontology-sdk/object-sets#text-search: %s name "%s" reads an underscore and a period as characters of the word, not as a pattern',
    async (type, value, primaryKeys) => {
      await insertObjects(service.db, ACCOUNT, [...TEXT_ACCOUNTS, accountRow('p-x-under'), accountRow('p-x-dot')]);

      const answer = await service.loadObjects(textSearch({ type, field: 'name', value }));

      expect(answer).toEqual(answerWith(primaryKeys));
    },
  );

  const PUNCTUATION_ACCOUNTS: readonly ObjectRow[] = [
    { accountId: 'p-w-comma', name: 'Acme, Inc.' },
    { accountId: 'p-w-slash', name: 'red/blue' },
    { accountId: 'p-w-quoted', name: "'quoted'" },
    { accountId: 'p-w-pi', name: '3.14' },
    { accountId: 'p-w-decade', name: "90's" },
    { accountId: 'p-w-thousand', name: '1_000' },
    { accountId: 'p-w-hyphen', name: 'x-ray' },
    { accountId: 'p-w-naive', name: 'na\u00efve' },
    { accountId: 'p-w-naive-nfd', name: 'nai\u0308ve' },
    { accountId: 'p-w-r2d2', name: 'R2D2' },
    { accountId: 'p-w-curly', name: 'O\u2019Brien' },
    { accountId: 'p-w-dots', name: 'a..b' },
    { accountId: 'p-w-net', name: '.net' },
    { accountId: 'p-w-han3', name: '\u{30000}\u{30001}' },
    { accountId: 'p-w-gap', name: 'zeta _ yarn' },
    { accountId: 'p-w-glued', name: 'zeta_ yarn' },
    { accountId: 'p-w-kana-dot', name: 'アクメ・ジャパン' },
    { accountId: 'p-w-kana-hyphen', name: 'アクメ゠ジャパン' },
  ];

  it.each([
    ['containsAnyTerm', 'acme', ['acc-1', 'p-t-words', 'p-w-comma']],
    ['containsAnyTerm', 'inc', ['p-w-comma']],
    ['containsAnyTerm', 'Inc.', ['p-w-comma']],
    ['containsAllTermsInOrder', 'acme inc', ['p-w-comma']],
    ['startsWith', 'acme in', ['p-w-comma']],
    ['containsAnyTerm', 'red', ['p-w-slash']],
    ['containsAnyTerm', 'blue', ['p-w-slash']],
    ['containsAnyTerm', 'red/blue', ['p-w-slash']],
    ['containsAllTermsInOrder', 'red blue', ['p-w-slash']],
    ['containsAnyTerm', 'quoted', ['p-w-quoted']],
    ['containsAnyTerm', "'quoted'", ['p-w-quoted']],
    ['containsAnyTerm', '3.14', ['p-w-pi']],
    ['containsAnyTerm', '14', []],
    ['containsAnyTerm', "90's", ['p-w-decade']],
    ['containsAnyTerm', '90', ['p-w-decade']],
    ['containsAnyTerm', '1_000', ['p-w-thousand']],
    ['containsAnyTerm', '000', []],
    ['containsAnyTerm', '_x', ['p-s-12']],
    ['containsAnyTerm', 'x', ['p-w-hyphen']],
    ['containsAnyTerm', '_', []],
    ['containsAnyTerm', 'ray', ['p-w-hyphen']],
    ['containsAllTermsInOrder', 'x ray', ['p-w-hyphen']],
    ['containsAnyTerm', 'na\u00efve', ['p-w-naive']],
    ['containsAnyTerm', 'na', []],
    ['containsAnyTerm', 'nai\u0308ve', ['p-w-naive-nfd']],
    ['containsAnyTerm', 'nai', []],
    ['containsAnyTerm', 'r2d2', ['p-w-r2d2']],
    ['containsAnyTerm', 'd2', []],
    ['containsAnyTerm', 'o\u2019brien', ['p-w-curly']],
    ['containsAnyTerm', 'brien', []],
    ['containsAnyTerm', 'a', ['p-w-dots']],
    ['containsAnyTerm', 'b', ['p-w-dots']],
    ['containsAnyTerm', 'net', ['p-w-net']],
    ['containsAnyTerm', '\u{30000}', ['p-w-han3']],
    ['containsAnyTerm', '\u{30001}', ['p-w-han3']],
    ['containsAllTermsInOrder', 'zeta _ yarn', ['p-w-gap']],
    ['containsAllTermsInOrder', 'zeta yarn', ['p-w-gap']],
    ['startsWith', 'zeta _ ya', ['p-w-gap']],
    ['startsWith', 'zeta ya', ['p-w-gap']],
    ['containsAllTermsInOrderPrefixLastTerm', 'zeta ya', ['p-w-gap']],
    ['containsAllTermsInOrder', 'zeta_ yarn', ['p-w-glued']],
    ['containsAnyTerm', 'ジャパン', ['p-w-kana-dot']],
    ['containsAnyTerm', 'アクメ', ['p-w-kana-dot']],
    ['containsAllTermsInOrder', 'アクメ ジャパン', ['p-w-kana-dot']],
    ['containsAnyTerm', 'アクメ゠ジャパン', ['p-w-kana-hyphen']],
  ] as const)(
    'ontology/ontology-sdk/object-sets#text-search: %s name "%s" finds each value with the words of the query, as the analyzer splits them',
    async (type, value, primaryKeys) => {
      await insertObjects(service.db, ACCOUNT, [...TEXT_ACCOUNTS, ...PUNCTUATION_ACCOUNTS]);

      const answer = await service.loadObjects({ ...textSearch({ type, field: 'name', value }), excludeRid: true });

      const body = answer.body as { data?: readonly { __primaryKey?: unknown }[] };

      expect({ status: answer.status, primaryKeys: body.data?.map((object) => object.__primaryKey) }).toEqual({
        status: 200,
        primaryKeys,
      });
    },
  );

  const EDGE_ACCOUNTS: readonly ObjectRow[] = [
    { accountId: 'p-e-2-v', name: '2 v' },
    { accountId: 'p-e-5-a1', name: '5.a1' },
    { accountId: 'p-e-abc-ascii', name: 'abc.1' },
    { accountId: 'p-e-abc-arabic', name: 'abc.٣' },
    { accountId: 'p-e-abc-d', name: 'abc.d' },
    { accountId: 'p-e-abc-han', name: 'abc.北' },
    { accountId: 'p-e-abc-kana', name: 'abc.タ' },
    { accountId: 'p-e-abc-under', name: 'abc._x' },
    { accountId: 'p-e-abc1-5', name: 'abc1.5' },
    { accountId: 'p-e-ab1-c', name: 'ab1.c' },
    { accountId: 'p-e-arabic', name: '١.٥' },
    { accountId: 'p-e-c-1ab', name: 'c.1ab' },
    { accountId: 'p-e-d-1abc', name: 'd.1abc' },
    { accountId: 'p-e-han-gap', name: '東_ acme' },
    { accountId: 'p-e-han-glued', name: '東acme' },
    { accountId: 'p-e-han-kana', name: '南タワー' },
    { accountId: 'p-e-han-pair', name: '南北' },
    { accountId: 'p-e-han-under', name: '東_acme' },
    { accountId: 'p-e-kana-glued', name: 'アクメジャパン' },
    { accountId: 'p-e-latin-gap', name: 'acme _西' },
    { accountId: 'p-e-latin-glued', name: 'acme西' },
    { accountId: 'p-e-latin-under', name: 'acme_西' },
    { accountId: 'p-e-one-abc-d', name: '1abc.d' },
    { accountId: 'p-e-v-2', name: 'v 2' },
    { accountId: 'p-e-vdot2', name: 'v.2' },
  ];

  it.each([
    [
      'containsAnyTerm',
      'acme.',
      ['acc-1', 'p-e-han-gap', 'p-e-han-glued', 'p-e-latin-gap', 'p-e-latin-glued', 'p-t-words'],
    ],
    ['containsAllTermsInOrder', 'v.2', ['p-e-v-2', 'p-e-vdot2']],
    ['containsAllTermsInOrder', '2.v', ['p-e-2-v']],
    [
      'containsAnyTerm',
      'abc',
      ['p-e-abc-arabic', 'p-e-abc-ascii', 'p-e-abc-han', 'p-e-abc-kana', 'p-e-abc-under', 'p-s-04', 'p-s-05', 'p-s-06'],
    ],
    ['containsAnyTerm', 'abc1', []],
    ['containsAnyTerm', 'abc1.5', ['p-e-abc1-5']],
    ['containsAnyTerm', '1abc', ['p-e-d-1abc', 'p-s-03']],
    ['containsAnyTerm', 'a1', ['p-e-5-a1']],
    ['containsAllTermsInOrder', 'ab1 c', ['p-e-ab1-c']],
    ['containsAllTermsInOrder', 'c 1ab', ['p-e-c-1ab']],
    ['containsAnyTerm', '١.٥', ['p-e-arabic']],
    ['containsAnyTerm', '١', []],
    ['containsAllTermsInOrder', 'アクメ ジャパン', []],
    ['containsAllTermsInOrder', '南 北', ['p-e-han-pair']],
    ['containsAllTermsInOrder', '南 タワー', ['p-e-han-kana']],
    ['containsAllTermsInOrder', '東 acme', ['p-e-han-gap', 'p-e-han-glued']],
    ['containsAllTermsInOrder', 'acme 西', ['p-e-latin-gap', 'p-e-latin-glued']],
  ] as const)(
    'ontology/ontology-sdk/object-sets#text-search: %s name "%s" splits the words at a joiner, a Han ideograph, and a run of Katakana, as the analyzer does',
    async (type, value, primaryKeys) => {
      await insertObjects(service.db, ACCOUNT, [...TEXT_ACCOUNTS, ...EDGE_ACCOUNTS]);

      const answer = await service.loadObjects({ ...textSearch({ type, field: 'name', value }), excludeRid: true });

      const body = answer.body as { data?: readonly { __primaryKey?: unknown }[] };

      expect({ status: answer.status, primaryKeys: body.data?.map((object) => object.__primaryKey) }).toEqual({
        status: 200,
        primaryKeys,
      });
    },
  );

  it.each([
    ['containsAnyTerm', '000', ['p-w-digits']],
    ['containsAnyTerm', '1', ['p-w-digits']],
    ['containsAllTermsInOrder', '1,000', ['p-w-digits']],
  ] as const)(
    'ontology/ontology-sdk/object-sets#text-search: %s name "%s" splits "1,000" at the comma, where Lucene keeps 1 word',
    async (type, value, primaryKeys) => {
      await insertObjects(service.db, ACCOUNT, [
        ...TEXT_ACCOUNTS,
        { accountId: 'p-w-digits', name: '1,000' },
        { accountId: 'p-w-thousand', name: '1_000' },
      ]);

      const answer = await service.loadObjects({ ...textSearch({ type, field: 'name', value }), excludeRid: true });

      const body = answer.body as { data?: readonly { __primaryKey?: unknown }[] };

      expect({ status: answer.status, primaryKeys: body.data?.map((object) => object.__primaryKey) }).toEqual({
        status: 200,
        primaryKeys,
      });
    },
  );

  it.each([
    ['containsAnyTerm', ''],
    ['containsAllTerms', '   '],
    ['containsAllTermsInOrder', ''],
    ['startsWith', ' - '],
  ] as const)(
    'ontology/ontology-sdk/object-sets#text-search: %s name "%s", a value with no word, matches no Object',
    async (type, value) => {
      await insertObjects(service.db, ACCOUNT, TEXT_ACCOUNTS);

      const answer = await service.loadObjects(textSearch({ type, field: 'name', value }));

      expect(answer).toEqual(answerWith([]));
    },
  );

  it.each([
    ['containsAnyTerm', 'acme', ['acc-1', 'p-t-words']],
    ['containsAllTerms', 'holdings acme', ['p-t-words']],
  ] as const)(
    'ontology/ontology-sdk/object-sets#text-search: %s name "%s" with fuzzy false, as @osdk/client 2.92.0 sends it, gives the expected answer',
    async (type, value, primaryKeys) => {
      await insertObjects(service.db, ACCOUNT, TEXT_ACCOUNTS);

      const answer = await service.loadObjects(textSearch({ type, field: 'name', value, fuzzy: false }));

      expect(answer).toEqual(answerWith(primaryKeys));
    },
  );
});

describe('the trigram index', () => {
  const NAME_INDEX = 'trgm_account_name_42403a5e';

  function indexNames(plan: unknown): string[] {
    if (Array.isArray(plan)) return plan.flatMap(indexNames);

    if (typeof plan !== 'object' || plan === null) return [];

    return Object.entries(plan).flatMap(([key, value]) =>
      key === 'Index Name' && typeof value === 'string' ? [value] : indexNames(value),
    );
  }

  it.each([
    ['containsAnyTerm', 'acme'],
    ['containsAnyTerm', 'globex initech'],
    ['containsAllTerms', 'holdings acme'],
    ['containsAllTermsInOrder', 'acme corp'],
    ['startsWith', 'acm'],
    ['containsAllTermsInOrderPrefixLastTerm', 'acm'],
  ] as const)(
    'ontology/ontology-sdk/object-sets#text-search: Postgres can read %s name "%s" with the trigram index of name',
    async (type, value) => {
      await insertObjects(service.db, ACCOUNT, TEXT_ACCOUNTS);

      const stream = vi.spyOn(service.db, 'stream');
      let read: Sql | undefined;

      try {
        const answer = await service.loadObjects(textSearch({ type, field: 'name', value }));

        expect(answer.status).toBe(200);

        read = stream.mock.calls.at(-1)?.[0];
      } finally {
        stream.mockRestore();
      }

      if (!read) throw new Error('loadObjects read no page with Db.stream.');

      const page = read;

      const [explained] = await service.db.transaction(async (tx) => {
        await tx.query(sql('SET LOCAL enable_seqscan = off'));

        await tx.query(sql('SET LOCAL enable_indexscan = off'));

        return tx.query<{ 'QUERY PLAN': unknown }>({ text: `EXPLAIN (FORMAT JSON) ${page.text}`, values: page.values });
      });

      expect(indexNames(explained?.['QUERY PLAN'])).toContain(NAME_INDEX);
    },
  );
});

describe('the Properties that take no text search', () => {
  const SEARCHABLE_ACCOUNTS: readonly ObjectRow[] = [
    { accountId: 'acc-1', name: 'Acme', phase: 'customer' },
    { accountId: 'acc-2', name: 'Globex', phase: 'prospect' },
    { accountId: 'acc-3', name: 'Initech', phase: 'closed' },
    { accountId: 'p-n-1', name: 'Probe One', note: 'alpha beta', active: true },
    { accountId: 'p-n-2', name: 'Probe Two', note: 'gamma', active: false },
    { accountId: 'p-n-3', name: 'Probe Three', note: 'alpha', active: true },
    { accountId: 'p-n-4', name: 'Probe Four' },
  ];

  const PROBES = { type: 'in', field: 'accountId', value: ['p-n-1', 'p-n-2', 'p-n-3', 'p-n-4'] };

  const onNote = (where: Readonly<Record<string, unknown>>) => ({
    objectSet: {
      type: 'filter',
      objectSet: { type: 'filter', objectSet: { type: 'base', objectType: ACCOUNT }, where: PROBES },
      where,
    },
    select: ['name', 'note'],
    orderBy: { fields: [{ field: 'accountId', direction: 'asc' }] },
  });

  const NOT_SEARCHABLE = {
    status: 400,
    body: {
      errorCode: 'INVALID_ARGUMENT',
      errorName: 'PropertiesNotSearchable',
      parameters: { propertyApiNames: ['note'] },
    },
  };

  it.each(['alpha', 'beta', 'alpha beta', 'Alpha'] as const)(
    'service/http-api#errors ontology/object-link-types/properties#searchable ontology/ontology-sdk/object-sets#text-search: containsAnyTerm note "%s" gets 400 PropertiesNotSearchable',
    async (value) => {
      await insertObjects(service.db, ACCOUNT, SEARCHABLE_ACCOUNTS);

      const answer = await service.loadObjects(onNote({ type: 'containsAnyTerm', field: 'note', value }));

      expect(errorAnswer(answer)).toEqual(NOT_SEARCHABLE);
    },
  );

  it.each([
    ['containsAllTerms', 'alpha'],
    ['containsAllTermsInOrder', 'alpha'],
    ['startsWith', 'al'],
    ['containsAllTermsInOrderPrefixLastTerm', 'al'],
  ] as const)(
    'service/http-api#errors ontology/object-link-types/properties#searchable: %s note "%s" gets 400 PropertiesNotSearchable',
    async (type, value) => {
      await insertObjects(service.db, ACCOUNT, SEARCHABLE_ACCOUNTS);

      const answer = await service.loadObjects(onNote({ type, field: 'note', value }));

      expect(errorAnswer(answer)).toEqual(NOT_SEARCHABLE);
    },
  );

  it.each([
    ['and', { type: 'and', value: [PROBES, { type: 'containsAnyTerm', field: 'note', value: 'alpha' }] }],
    ['not', { type: 'not', value: { type: 'containsAnyTerm', field: 'note', value: 'alpha' } }],
  ] as const)(
    'service/http-api#errors ontology/object-link-types/properties#searchable: a text search on note inside %s gets 400 PropertiesNotSearchable',
    async (_case, where) => {
      await insertObjects(service.db, ACCOUNT, SEARCHABLE_ACCOUNTS);

      const answer = await service.loadObjects({
        objectSet: { type: 'filter', objectSet: { type: 'base', objectType: ACCOUNT }, where },
        select: ['name', 'note'],
      });

      expect(errorAnswer(answer)).toEqual(NOT_SEARCHABLE);
    },
  );

  it.each([
    ['containsAnyTerm', 'red'],
    ['containsAllTerms', 'red'],
    ['containsAllTermsInOrder', 'red'],
    ['startsWith', 're'],
    ['containsAllTermsInOrderPrefixLastTerm', 're'],
  ] as const)(
    'ontology/ontology-sdk/object-sets#text-search: %s tags "%s" on the String array Property tags gets 400 InvalidPropertyType',
    async (type, value) => {
      await insertObjects(service.db, ACCOUNT, [
        { accountId: 'acc-1', name: 'Acme', phase: 'customer', tags: ['red'] },
        { accountId: 'acc-2', name: 'Globex', phase: 'prospect', tags: ['red', 'blue'] },
        { accountId: 'acc-3', name: 'Initech', phase: 'closed' },
      ]);

      const answer = await service.loadObjects(textSearch({ type, field: 'tags', value }));

      expect(errorAnswer(answer)).toEqual({
        status: 400,
        body: {
          errorCode: 'INVALID_ARGUMENT',
          errorName: 'InvalidPropertyType',
          parameters: { property: 'tags', propertyBaseType: 'Array<String>' },
        },
      });
    },
  );

  it('ontology/ontology-sdk/object-sets#text-search: containsAnyTerm on the Boolean Property active gets 400 InvalidPropertyType', async () => {
    await insertObjects(service.db, ACCOUNT, SEARCHABLE_ACCOUNTS);

    const answer = await service.loadObjects(textSearch({ type: 'containsAnyTerm', field: 'active', value: 'true' }));

    expect(errorAnswer(answer)).toEqual({
      status: 400,
      body: {
        errorCode: 'INVALID_ARGUMENT',
        errorName: 'InvalidPropertyType',
        parameters: { property: 'active', propertyBaseType: 'Boolean' },
      },
    });
  });

  it.each([
    ['containsAnyTerm', 'introduced'],
    ['containsAllTerms', 'introduced'],
    ['containsAllTermsInOrder', 'introduced'],
    ['startsWith', 'intro'],
    ['containsAllTermsInOrderPrefixLastTerm', 'intro'],
  ] as const)(
    'ontology/ontology-sdk/object-sets#text-search: %s on the String struct field relationship.label gets 400 PropertiesNotSearchable',
    async (type, value) => {
      await insertObjects(service.db, STRUCT_PROBE, [
        { probeId: 'sp-1', relationship: { label: 'introduced' }, measures: {} },
      ]);

      const answer = await service.loadObjects({
        objectSet: {
          type: 'filter',
          objectSet: { type: 'base', objectType: STRUCT_PROBE },
          where: {
            type,
            propertyIdentifier: { type: 'structField', propertyApiName: 'relationship', structFieldApiName: 'label' },
            value,
          },
        },
        select: [],
      });

      expect(errorAnswer(answer)).toEqual({
        status: 400,
        body: {
          errorCode: 'INVALID_ARGUMENT',
          errorName: 'PropertiesNotSearchable',
          parameters: { propertyApiNames: ['relationship.label'] },
        },
      });
    },
  );
});

describe('the text queries outside V1', () => {
  it.each([
    ['regex', { type: 'regex', field: 'name', value: 'Ac.*' }, 'regex'],
    [
      'interval',
      { type: 'interval', field: 'name', rule: { type: 'match', query: 'acme', ordered: false } },
      'interval',
    ],
    [
      'containsAnyTerm with fuzzy true',
      { type: 'containsAnyTerm', field: 'name', value: 'acme', fuzzy: true },
      'fuzzy',
    ],
    [
      'containsAllTerms with fuzzy true',
      { type: 'containsAllTerms', field: 'name', value: 'acme', fuzzy: true },
      'fuzzy',
    ],
  ] as const)(
    'ontology/ontology-sdk/object-sets#text-search: %s on name gets 400 PropertyFiltersNotSupported',
    async (_case, where, filter) => {
      await insertObjects(service.db, ACCOUNT, TEXT_ACCOUNTS);

      const answer = await service.loadObjects(textSearch(where));

      expect(errorAnswer(answer)).toEqual({
        status: 400,
        body: {
          errorCode: 'INVALID_ARGUMENT',
          errorName: 'PropertyFiltersNotSupported',
          parameters: { property: 'name', propertyFilters: [filter] },
        },
      });
    },
  );
});

describe('the analyzer of a text search', () => {
  const RULE = 'ontology/ontology-sdk/object-sets#text-search';

  const QUERIES = [
    ['containsAnyTerm', 'acme'],
    ['containsAllTerms', 'holdings acme'],
    ['containsAllTermsInOrder', 'acme corp'],
    ['startsWith', 'acm'],
    ['containsAllTermsInOrderPrefixLastTerm', 'acm'],
  ] as const;

  beforeEach(() => insertObjects(service.db, ACCOUNT, TEXT_ACCOUNTS));

  it.each(QUERIES)(
    `${RULE}: %s name "%s" with BASE_ANALYZER gives the answer of no analyzerSelection`,
    async (type, value) => {
      const plain = await service.loadObjects(textSearch({ type, field: 'name', value }));

      expect(plain.status).toBe(200);
      expect((plain.body as { data: unknown[] }).data).not.toEqual([]);

      expect(
        await service.loadObjects(textSearch({ type, field: 'name', value, analyzerSelection: 'BASE_ANALYZER' })),
      ).toEqual(plain);
    },
  );

  it.each(QUERIES)(
    `${RULE}: %s name "%s" with PHONETIC_ANALYZER gets 400 UnsupportedAnalyzerSelection`,
    async (type, value) => {
      const answer = await service.loadObjects(
        textSearch({ type, field: 'name', value, analyzerSelection: 'PHONETIC_ANALYZER' }),
      );

      expect(errorAnswer(answer)).toEqual({
        status: 400,
        body: {
          errorCode: 'INVALID_ARGUMENT',
          errorName: 'UnsupportedAnalyzerSelection',
          parameters: { analyzerSelection: 'PHONETIC_ANALYZER' },
        },
      });
    },
  );

  it.each([['NGRAM_ANALYZER'], [true]] as const)(
    `${RULE}: analyzerSelection %j gets 400 Default:InvalidArgument`,
    async (analyzerSelection) => {
      const query = { type: 'containsAnyTerm', field: 'name', value: 'acme', analyzerSelection };

      const answer = await service.loadObjects(textSearch(query));

      expect(errorAnswer(answer)).toEqual({
        status: 400,
        body: {
          errorCode: 'INVALID_ARGUMENT',
          errorName: 'Default:InvalidArgument',
          parameters: { field: 'where', query },
        },
      });
    },
  );
});

describe('the limits of a text search', () => {
  const BASE = { type: 'base', objectType: ACCOUNT };

  const words = (count: number, first: string) =>
    [first, ...Array.from({ length: count - 1 }, (_, index) => `w${index}`)].join(' ');

  const anyTerm = (count: number, first: string) => ({
    type: 'containsAnyTerm',
    field: 'name',
    value: words(count, first),
  });

  const over = (maximum: number): Answer => ({
    status: 400,
    body: {
      errorCode: 'INVALID_ARGUMENT',
      errorName: 'Default:InvalidArgument',
      parameters: { field: 'where', maximum },
    },
  });

  async function readsOf(send: () => Promise<Answer>): Promise<{ answer: Answer; reads: number }> {
    const stream = vi.spyOn(service.db, 'stream');

    try {
      const answer = await send();

      return { answer: answer.status === 200 ? answer : errorAnswer(answer), reads: stream.mock.calls.length };
    } finally {
      stream.mockRestore();
    }
  }

  beforeEach(() => insertObjects(service.db, ACCOUNT, ['acc-1', 'acc-2', 'acc-3'].map(accountRow)));

  it('ontology/ontology-sdk/object-sets#text-search: a text search of 16 words reads the Objects', async () => {
    const { answer, reads } = await readsOf(() => service.loadObjects(textSearch(anyTerm(16, 'acme'))));

    expect(answer).toEqual(answerWith(['acc-1']));
    expect(reads).toBe(1);
  });

  it.each([
    'containsAnyTerm',
    'containsAllTerms',
    'containsAllTermsInOrder',
    'containsAllTermsInOrderPrefixLastTerm',
    'startsWith',
  ] as const)(
    'ontology/ontology-sdk/object-sets#text-search: %s with 17 words gets 400 Default:InvalidArgument, and reads no data',
    async (type) => {
      const { answer, reads } = await readsOf(() =>
        service.loadObjects(textSearch({ type, field: 'name', value: words(17, 'acme') })),
      );

      expect(answer).toEqual(over(16));
      expect(reads).toBe(0);
    },
  );

  const nested = (first: number, second: number) => ({
    type: 'and',
    value: [
      anyTerm(first, 'acme'),
      {
        type: 'or',
        value: [{ type: 'not', value: { type: 'containsAllTerms', field: 'name', value: words(second, 'globex') } }],
      },
    ],
  });

  it('ontology/ontology-sdk/object-sets#text-search: 2 text searches of 8 words each, inside and, or, and not, read the Objects', async () => {
    const { answer, reads } = await readsOf(() => service.loadObjects(textSearch(nested(8, 8))));

    expect(answer).toEqual(answerWith(['acc-1']));
    expect(reads).toBe(1);
  });

  it('ontology/ontology-sdk/object-sets#text-search: a text search of 9 words and one of 8 words, inside and, or, and not, get 400 Default:InvalidArgument, and read no data', async () => {
    const { answer, reads } = await readsOf(() => service.loadObjects(textSearch(nested(9, 8))));

    expect(answer).toEqual(over(16));
    expect(reads).toBe(0);
  });

  const filter = (where: unknown, objectSet: unknown = BASE) => ({ type: 'filter', objectSet, where });

  const ordered = (objectSet: unknown) => ({
    objectSet,
    select: ['name'],
    orderBy: { fields: [{ field: 'accountId', direction: 'asc' }] },
  });

  it('ontology/ontology-sdk/object-sets#text-search: a union of 2 filter members of 8 words each reads the Objects', async () => {
    const union = { type: 'union', objectSets: [filter(anyTerm(8, 'acme')), filter(anyTerm(8, 'globex'))] };

    const { answer, reads } = await readsOf(() => service.loadObjects(ordered(union)));

    expect(answer).toEqual(answerWith(['acc-1', 'acc-2']));
    expect(reads).toBe(1);
  });

  it.each([
    ['a union', { type: 'union', objectSets: [filter(anyTerm(9, 'acme')), filter(anyTerm(8, 'globex'))] }],
    ['an intersect', { type: 'intersect', objectSets: [filter(anyTerm(9, 'acme')), filter(anyTerm(8, 'globex'))] }],
    ['a subtract', { type: 'subtract', objectSets: [filter(anyTerm(9, 'acme')), filter(anyTerm(8, 'globex'))] }],
    ['a filter member of a filter member', filter(anyTerm(9, 'acme'), filter(anyTerm(8, 'globex')))],
    [
      'a filter member of a union',
      filter(anyTerm(9, 'acme'), { type: 'union', objectSets: [BASE, filter(anyTerm(8, 'globex'))] }),
    ],
  ])(
    'ontology/ontology-sdk/object-sets#text-search: %s with a text search of 9 words and one of 8 words gets 400 Default:InvalidArgument, and reads no data',
    async (_case, objectSet) => {
      const { answer, reads } = await readsOf(() => service.loadObjects(ordered(objectSet)));

      expect(answer).toEqual(over(16));
      expect(reads).toBe(0);
    },
  );

  it('ontology/ontology-sdk/object-sets#text-search: an aggregate of a text search of 16 words counts the Objects, and one of 17 words gets 400 Default:InvalidArgument, and reads no data', async () => {
    const count = (where: unknown) =>
      service.aggregate({ objectSet: filter(where), aggregation: [{ type: 'count' }], groupBy: [] });

    const within = await readsOf(() => count(anyTerm(16, 'acme')));

    expectAggregate(within.answer, {
      status: 200,
      body: { accuracy: 'ACCURATE', data: [{ group: {}, metrics: [{ name: 'count', value: 1 }] }] },
    });

    expect(within.reads).toBe(1);

    const beyond = await readsOf(() => count(anyTerm(17, 'acme')));

    expect(beyond.answer).toEqual(over(16));
    expect(beyond.reads).toBe(0);
  });

  it.each([
    ['a', 'a'],
    ['U+1D400', '\u{1d400}'],
  ])(
    'ontology/ontology-sdk/object-sets#text-search: a value of 256 characters %s reads the Objects, and 257 characters get 400 Default:InvalidArgument, and read no data',
    async (_case, character) => {
      await insertObjects(service.db, ACCOUNT, [{ accountId: 'long', name: character.repeat(256) }]);

      const search = (length: number) =>
        service.loadObjects(textSearch({ type: 'containsAllTerms', field: 'name', value: character.repeat(length) }));

      const within = await readsOf(() => search(256));

      expect(pageOf(within.answer)).toMatchObject({ status: 200, primaryKeys: ['long'], totalCount: '1' });
      expect(within.reads).toBe(1);

      const beyond = await readsOf(() => search(257));

      expect(beyond.answer).toEqual(over(256));
      expect(beyond.reads).toBe(0);
    },
  );

  it('ontology/ontology-sdk/object-sets#text-search: an aggregate of a text search with a value of 257 characters gets 400 Default:InvalidArgument, and reads no data', async () => {
    const { answer, reads } = await readsOf(() =>
      service.aggregate({
        objectSet: filter({ type: 'startsWith', field: 'name', value: 'a'.repeat(257) }),
        aggregation: [{ type: 'count' }],
        groupBy: [],
      }),
    );

    expect(answer).toEqual(over(256));
    expect(reads).toBe(0);
  });
});
