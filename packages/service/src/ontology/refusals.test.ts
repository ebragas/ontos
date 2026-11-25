import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { handle, type HandleInput } from '../handler/index.ts';
import { errorAnswer, testInput, testSettings } from '../service.test-utils.ts';
import { createTestIssuer } from '../tokens.test-utils.ts';
import { compileOntology, emptyOntology, type StoredFunctions } from './index.ts';
import {
  compileOrThrow,
  NS,
  ONTOLOGY_RID,
  policiesIr,
  propertyPoliciesIr,
  stored,
  twinFunctions,
  twinGrantsFile,
} from './stored.test-utils.ts';

const ACC = `${NS}Account`;
const ENG = `${NS}Engagement`;

interface Doc {
  ir: unknown;
  functions: unknown;
  rid: string;
}

const DEL = Symbol('delete');

type Json = Record<string, unknown>;

function get(doc: Doc, path: string): unknown {
  let at: unknown = doc;

  for (const key of path.split('/')) at = (at as Json)[key];

  return at;
}

function put(doc: Doc, path: string, value: unknown): void {
  const keys = path.split('/');
  const last = keys.pop() as string;
  const parent = keys.reduce<unknown>((at, key) => (at as Json)[key], doc) as Json;

  if (value === DEL) Reflect.deleteProperty(parent, last);
  else parent[last] = value;
}

type Edit = readonly [path: string, value: unknown] | ((doc: Doc) => void);

type Base = 'policies' | 'property' | 'derived' | 'valueTypes';

interface Case {
  readonly name: string;
  readonly base: Base;
  readonly edits: readonly Edit[];
}

const cases: Case[] = [];

const compileCase =
  (base: Base) =>
  (name: string, ...edits: Edit[]): void => {
    cases.push({ name, base, edits });
  };

const t = compileCase('policies');
const p = compileCase('property');
const d = compileCase('derived');
const v = compileCase('valueTypes');

const ot = (name: string) => `ir/ontology/objectTypes/${NS}${name}`;
const oty = (name: string) => `${ot(name)}/objectType`;
const prop = (objectType: string, property: string) => `${oty(objectType)}/propertyTypes/${property}`;
const at = (name: string) => `ir/ontology/actionTypes/${NS}${name}/actionType`;
const lt = (id: string) => `ir/ontology/linkTypes/${id}/linkType`;
const logicRule = (action: string, index = 0) => `${at(action)}/actionTypeLogic/logic/rules/${index}`;

const pv = (action: string, parameter: string) =>
  `${at(action)}/actionTypeLogic/validation/parameterValidations/${parameter}`;

const allowedOf = (action: string, parameter: string) =>
  `${pv(action, parameter)}/defaultValidation/validation/allowedValues`;

const requiredOf = (action: string, parameter: string) =>
  `${pv(action, parameter)}/defaultValidation/validation/required`;

const criterion = (action: string) =>
  `${at(action)}/actionTypeLogic/validation/actionTypeLevelValidation/rules/0/condition`;

const mp = (action: string, parameter: string) => `${at(action)}/metadata/parameters/${parameter}`;

const group = (index: number, objectType = 'Account') =>
  `${ot(objectType)}/datasources/0/datasource/datasetV3/propertySecurityGroups/groups/${index}`;

const cond = (index: number) =>
  `${group(0)}/security/granular/viewPolicy/granularPolicyCondition/or/conditions/${index}`;

const fn = (index: number) => `functions/discovered/${index}`;

const copy =
  (from: string, to: string) =>
  (doc: Doc): void => {
    put(doc, to, structuredClone(get(doc, from)));
  };

const noFunctions = (doc: Doc): void => {
  doc.functions = undefined;

  for (const name of ['close-account-action', 'probe-version-check-action', 'set-relationship-action'])
    put(doc, `ir/ontology/actionTypes/${NS}${name}`, DEL);
};

const STRING_TYPE = {
  type: 'string',
  string: { isLongText: false, supportsEfficientLeadingWildcard: false, supportsExactMatching: true },
};

const wrapped = (type: string, body: unknown = {}) => ({ type, [type]: body });
const param = (parameterId: string) => ({ type: 'parameterId', parameterId });
const text = (value: string) => ({ type: 'staticValue', staticValue: { type: 'string', string: value } });

const comparison = (operator: string, left: unknown, right: unknown) => ({
  type: 'comparison',
  comparison: { operator, left, right },
});

const person = (propertyValue: unknown) => ({
  type: 'userProperty',
  userProperty: { userId: { type: 'currentUser', currentUser: {} }, propertyValue },
});

const userId = { type: 'userId', userId: {} };
const groupIds = { type: 'groupIds', groupIds: {} };
const policyPerson = (userProperty: unknown) => ({ type: 'userProperty', userProperty });
const constant = (...strings: string[]) => ({ type: 'constant', constant: { type: 'strings', strings } });

const addParameter =
  (action: string, id: string, type: unknown, allowedValues: unknown) =>
  (doc: Doc): void => {
    put(doc, mp(action, id), { id, type, displayMetadata: { displayName: id, description: '', typeClasses: [] } });

    put(doc, `${at(action)}/metadata/parameterOrdering`, [
      ...(get(doc, `${at(action)}/metadata/parameterOrdering`) as string[]),
      id,
    ]);

    put(doc, pv(action, id), {
      defaultValidation: {
        display: { renderHint: { type: 'textInput', textInput: {} }, visibility: { type: 'editable', editable: {} } },
        validation: { allowedValues, required: { type: 'notRequired', notRequired: {} } },
      },
      conditionalOverrides: [],
    });
  };

const linkAction = (rule: unknown) => (doc: Doc) => {
  put(
    doc,
    `ir/ontology/actionTypes/${NS}link-it`,
    structuredClone(get(doc, `ir/ontology/actionTypes/${NS}copy-account-phase`)),
  );

  put(doc, `${at('link-it')}/metadata/apiName`, `${NS}link-it`);

  put(doc, `${at('link-it')}/actionTypeLogic/logic/rules`, [rule]);
};

const linkRule = (body: Json) => ({
  type: 'addLinkRule',
  addLinkRule: {
    linkTypeId: 'engagement-partners',
    sourceObject: 'objectToModifyParameter',
    targetObject: 'account',
    ...body,
  },
});

t('the Ontology RID has no UUID', ['rid', 'ri.ontology.main.ontology.nope']);

t('the IR is not an object', ['ir', 5]);

t('the ontology block is not an object', ['ir/ontology', 5]);

t('the IR has no objectTypes', ['ir/ontology/objectTypes', DEL]);

t('a root value type with no versions', ['ir/valueTypes', { valueTypes: [{ metadata: { apiName: 'Money' } }] }]);

t('a root value type with no metadata', ['ir/valueTypes', { valueTypes: [{}] }]);

t('a root Interface', ['ir/ontology/interfaceTypes', { Thing: {} }]);

t('a root Shared Property', ['ir/ontology/sharedPropertyTypes', { Size: {} }]);

t('the Interfaces are not an object', ['ir/ontology/interfaceTypes', 5]);

t('an array that is an object', [`${logicRule('create-engagement', 0).replace('/0', '')}`, {}]);

t('an API name that is not a string', [`${oty('Account')}/apiName`, 5]);

t('an optional boolean that is a string', [`${ot('Account')}/entityMetadata/arePatchesEnabled`, 'yes']);

t('a status of an unknown kind', [`${oty('Account')}/status`, { type: 'weird' }]);

t('a status that is not an object', [`${oty('Account')}/status`, 5]);

t('an Object Type API name that gives the version column', [`${oty('Account')}/apiName`, `${NS}__version`]);

t('an Object Type API name that is reserved', [`${oty('Account')}/apiName`, `${NS}Object`]);

t('an Object Type API name that is too long', [`${oty('Account')}/apiName`, `${NS}${'A'.repeat(100)}`]);

t('an Object Type API name with no namespace', [`${oty('Account')}/apiName`, 'Account']);

t('an Object Type API name that starts with a lowercase letter', [`${oty('Account')}/apiName`, `${NS}account`]);

t('a Property API name that is reserved', [`${prop('Account', 'name')}/apiName`, 'rid']);

t('a Property API name that gives the version column', [`${prop('Account', 'name')}/apiName`, '__version']);

t('a Property API name with a dash', [`${prop('Account', 'name')}/apiName`, 'Bad-Name']);

t('a Link Type ID that is an OSDK RID', [`${lt('account-to-engagements')}/id`, 'ri.ontology.main.relation.x']);

t('a Link Type ID that is not kebab case', [`${lt('account-to-engagements')}/id`, 'Foo']);

t('a Link Type API name that starts with a digit', [`${lt('account-to-engagements')}/id`, '1abc']);

t('a Link Type API name that is reserved', [`${lt('account-to-engagements')}/id`, 'link']);

t('a Link side API name that is reserved', [
  `${lt('account-to-engagements')}/definition/oneToMany/oneToManyLinkMetadata/apiName`,
  'rid',
]);

t('a Link side API name with a capital', [
  `${lt('account-to-engagements')}/definition/oneToMany/oneToManyLinkMetadata/apiName`,
  'Bad',
]);

t('a struct field API name with a capital', [
  `${prop('StructProbe', 'relationship')}/type/struct/structFields/0/apiName`,
  'Bad',
]);

t('an Action Type API name that is too long', [`${at('create-account')}/metadata/apiName`, `${NS}${'a'.repeat(100)}`]);

t('an Action Type API name with an underscore', [`${at('create-account')}/metadata/apiName`, `${NS}bad_name`]);

t('an Action Type API name that is reserved', [`${at('create-account')}/metadata/apiName`, `${NS}ontology`]);

t('an Action Type API name with another API namespace', [
  `${at('create-account')}/metadata/apiName`,
  'com.other.create-account',
]);

t('an Action Type API name with no namespace', [`${at('create-account')}/metadata/apiName`, 'create-account']);

t('an Object Type with no display name', [`${oty('Account')}/displayMetadata/displayName`, '']);

t('an Object Type with no plural display name', [`${oty('Account')}/displayMetadata/pluralDisplayName`, DEL]);

t('an Object Type with a visibility that is not known', [`${oty('Account')}/displayMetadata/visibility`, 'LOUD']);

t('a Property with no display name', [`${prop('Account', 'name')}/displayMetadata/displayName`, '']);

t('a Property type class that is not an object', [`${prop('Account', 'name')}/typeClasses`, [5]]);

t('a Property with no base type', [`${prop('Account', 'name')}/type`, {}]);

t('a Property of the Long type', [`${prop('Account', 'name')}/type`, wrapped('long')]);

t('a Property of the Geopoint type', [`${prop('Account', 'name')}/type`, wrapped('geohash')]);

t('a Property of a mandatory marking type', [
  `${prop('Account', 'name')}/type`,
  { type: 'marking', marking: { markingType: 'MANDATORY' } },
]);

t('a Property of a marking type', [
  `${prop('Account', 'name')}/type`,
  { type: 'marking', marking: { markingType: 'CBAC' } },
]);

t('a Property of a type that V1 does not know', [`${prop('Account', 'name')}/type`, wrapped('weird')]);

t('an array Property with reducers', [
  `${prop('Account', 'name')}/type`,
  { type: 'array', array: { subtype: STRING_TYPE, reducers: [{}] } },
]);

t('an array of arrays', [`${prop('Account', 'name')}/type`, { type: 'array', array: { subtype: wrapped('array') } }]);

t('an array of structs', [`${prop('Account', 'name')}/type`, { type: 'array', array: { subtype: wrapped('struct') } }]);

t('an array of Long', [`${prop('Account', 'name')}/type`, { type: 'array', array: { subtype: wrapped('long') } }]);

t('a string array with an analyzer override', [
  `${prop('Account', 'name')}/type`,
  { type: 'array', array: { subtype: { type: 'string', string: { analyzerOverride: {} } } } },
]);

t('a string with an analyzer override', [
  `${prop('Account', 'name')}/type`,
  { type: 'string', string: { analyzerOverride: {} } },
]);

t('a struct with no field', [`${prop('StructProbe', 'relationship')}/type/struct/structFields`, []]);

t('a struct field that is not an object', [`${prop('StructProbe', 'relationship')}/type/struct/structFields/0`, 5]);

t(
  'a struct with 2 fields of 1 name',
  copy(
    `${prop('StructProbe', 'relationship')}/type/struct/structFields/0`,
    `${prop('StructProbe', 'relationship')}/type/struct/structFields/2`,
  ),
);

t('a struct field that is an array', [
  `${prop('StructProbe', 'relationship')}/type/struct/structFields/0/fieldType`,
  { type: 'array', array: { subtype: STRING_TYPE } },
]);

t('a struct field that is a struct', [
  `${prop('StructProbe', 'relationship')}/type/struct/structFields/0/fieldType`,
  wrapped('struct'),
]);

t('a struct field of the Long type', [
  `${prop('StructProbe', 'relationship')}/type/struct/structFields/0/fieldType`,
  wrapped('long'),
]);

t('a Decimal with a precision above 38', [
  `${prop('Account', 'name')}/type`,
  { type: 'decimal', decimal: { precision: 50, scale: 2 } },
]);

t('a Decimal with a negative scale', [
  `${prop('Account', 'name')}/type`,
  { type: 'decimal', decimal: { precision: 10, scale: -1 } },
]);

t('2 Object Types with 1 API name', copy(ot('Account'), `ir/ontology/objectTypes/Copy`));

t('an Object Type with no Property', [`${oty('Account')}/propertyTypes`, {}]);

t('an Object Type with 1501 Properties', (doc) => {
  const properties: Json = {};

  for (let i = 0; i < 1501; i += 1)
    properties[`p${i}`] = { ...(get(doc, prop('Account', 'name')) as Json), apiName: `p${i}` };

  put(doc, `${oty('Account')}/propertyTypes`, properties);
});

t('an Object Type with no primary key', [`${oty('Account')}/primaryKeys`, []]);

t('an Object Type with 2 primary keys', [`${oty('Account')}/primaryKeys`, ['accountId', 'name']]);

t('an Object Type with no title key', [`${oty('Account')}/titlePropertyTypeRid`, DEL]);

t('an Object Type with a title key that is not a Property', [`${oty('Account')}/titlePropertyTypeRid`, 'nope']);

t('an Object Type with a primary key that is not a Property', [`${oty('Account')}/primaryKeys`, ['nope']]);

t('2 Properties with 1 API name', copy(prop('Account', 'name'), prop('Account', 'copy')));

t('an Object Type with an edit history of an unknown kind', [
  `${ot('Account')}/entityMetadata/editsHistory`,
  wrapped('weird'),
]);

t('an Object Type with an edit history stored with another type', [
  `${ot('Account')}/entityMetadata/editsHistory`,
  { type: 'config', config: { store: 'Other' } },
]);

t('an Object Type with an edit history that is not an object', [`${ot('Account')}/entityMetadata`, 5]);

t('a primary key that is not a String', [`${prop('Account', 'accountId')}/type`, wrapped('integer')]);

t(
  'a title key that is an array',
  [`${prop('Account', 'phase')}/type`, { type: 'array', array: { subtype: STRING_TYPE } }],
  [`${oty('Account')}/titlePropertyTypeRid`, 'phase'],
);

t(
  'a title key that is a struct',
  [`${oty('Account')}/titlePropertyTypeRid`, 'phase'],
  [
    `${prop('Account', 'phase')}/type`,
    {
      type: 'struct',
      struct: {
        structFields: [
          {
            apiName: 'a',
            displayMetadata: { displayName: 'a' },
            typeClasses: [],
            aliases: [],
            fieldType: wrapped('boolean'),
          },
        ],
      },
    },
  ],
);

t('a Property with no API name', [`${prop('Account', 'name')}/apiName`, '']);

t('a Property with noEmptyCollections and no noNulls', [
  `${prop('Account', 'name')}/dataConstraints`,
  { nullabilityV2: { noNulls: false, noEmptyCollections: true } },
]);

t('a Property value type with no API name', [`${prop('Account', 'name')}/valueType`, { x: 1 }]);

t('a Property with a Shared Property', [`${prop('Account', 'name')}/sharedPropertyTypeApiName`, 'Size']);

t('a Property with property type constraints and no value type', [
  `${prop('Account', 'name')}/dataConstraints`,
  { propertyTypeConstraints: [{}] },
]);

t('a Property with a nullability of the old kind', [
  `${prop('Account', 'name')}/dataConstraints`,
  { nullability: 'x' },
]);

t('an Object Type that implements an Interface', [
  `${oty('Account')}/implementsInterfaces2`,
  [{ interfaceTypeApiName: 'Thing' }],
]);

t('an Object Type with allImplementsInterfaces', [`${oty('Account')}/allImplementsInterfaces`, { Thing: {} }]);

t('an Object Type with a derived datasource', [
  `${ot('Account')}/datasources/0/datasource`,
  { type: 'derived', derived: { definition: { type: 'x', x: { propertyTypeMapping: { a: 1 } } } } },
]);

t('2 Link Types with 1 API name', copy('ir/ontology/linkTypes/account-to-engagements', 'ir/ontology/linkTypes/copy'));

t('a Link side with the API name of a Property', [
  `${lt('account-to-engagements')}/definition/oneToMany/oneToManyLinkMetadata/apiName`,
  'name',
]);

t('2 Link sides with 1 API name', [
  `${lt('account-to-engagements')}/definition/oneToMany/oneToManyLinkMetadata/apiName`,
  'partnerEngagements',
]);

t('an object-backed Link Type', [
  `${lt('account-to-engagements')}/definition`,
  { type: 'intermediary', intermediary: {} },
]);

t('a Link Type definition that is not known', [
  `${lt('account-to-engagements')}/definition`,
  { type: 'weird', weird: {} },
]);

t('a one-to-one Link Type', [`${lt('account-to-engagements')}/definition/oneToMany/cardinalityHint`, 'ONE_TO_ONE']);

t('a Link Type with a cardinality hint that is not known', [
  `${lt('account-to-engagements')}/definition/oneToMany/cardinalityHint`,
  'MANY',
]);

t('a Link Type to an Object Type that does not exist', [
  `${lt('account-to-engagements')}/definition/oneToMany/objectTypeRidOneSide`,
  'Nope',
]);

t('a Link Type with no foreign key mapping', [
  `${lt('account-to-engagements')}/definition/oneToMany/oneSidePrimaryKeyToManySidePropertyMapping`,
  [],
]);

t('a Link Type with a mapping that starts at another Object Type', [
  `${lt('account-to-engagements')}/definition/oneToMany/oneSidePrimaryKeyToManySidePropertyMapping/0/from/object`,
  ENG,
]);

t('a Link Type with a mapping that starts at another Property', [
  `${lt('account-to-engagements')}/definition/oneToMany/oneSidePrimaryKeyToManySidePropertyMapping/0/from/apiName`,
  'name',
]);

t('a Link Type with a foreign key on another Object Type', [
  `${lt('account-to-engagements')}/definition/oneToMany/oneSidePrimaryKeyToManySidePropertyMapping/0/to/object`,
  ACC,
]);

t('a Link Type with a foreign key that is not a Property', [
  `${lt('account-to-engagements')}/definition/oneToMany/oneSidePrimaryKeyToManySidePropertyMapping/0/to/apiName`,
  'nope',
]);

t('a Link Type with a foreign key of another type', [`${prop('Engagement', 'accountId')}/type`, wrapped('integer')]);

t('a Link side with no API name', [
  `${lt('account-to-engagements')}/definition/oneToMany/oneToManyLinkMetadata/apiName`,
  '',
]);

t('a Link side with a visibility', [
  `${lt('account-to-engagements')}/definition/oneToMany/oneToManyLinkMetadata/displayMetadata/visibility`,
  'HIDDEN',
]);

t('a Link side with type classes', [
  `${lt('account-to-engagements')}/definition/oneToMany/oneToManyLinkMetadata/typeClasses`,
  [{ kind: 'a', name: 'b' }],
]);

t('a many-to-many Link Type to an Object Type that does not exist', [
  `${lt('engagement-partners')}/definition/manyToMany/objectTypeRidB`,
  'Nope',
]);

t('the Functions are not an object', ['functions', 5]);

t('the discovered Functions are not a list', ['functions/discovered', {}]);

t('2 discovered Functions with 1 name', copy(fn(0), fn(3)));

t('a Function with a Client that is not first', [`${fn(0)}/inputs/1`, { name: 'c', dataType: wrapped('client') }]);

t('a Function with a durable context', [`${fn(0)}/inputs/1`, { name: 'c', dataType: wrapped('durableContext') }]);

t('a Function input of the Long type', [`${fn(0)}/inputs/2/dataType`, wrapped('long')]);

t('a Function input that is a list of Long', [
  `${fn(0)}/inputs/2/dataType`,
  { type: 'list', list: { elementsType: wrapped('long') } },
]);

t('a Function input that is an Object of an unknown type', [`${fn(0)}/inputs/1/dataType/object/objectTypeId`, 'Nope']);

t('a Function input with a custom type that is missing', [
  `${fn(0)}/inputs/2/dataType`,
  { type: 'functionCustomType', functionCustomType: 'Nope' },
]);

t('a Function input with allowedValues that is not a String', [`${fn(0)}/inputs/1/allowedValues`, ['a']]);

t('a Function input with no allowed value', [`${fn(0)}/inputs/2/allowedValues`, []]);

t('a Function that edits an Object Type with edits off', [`${ot('Account')}/entityMetadata/arePatchesEnabled`, false]);

t('a Function input with an anonymous custom struct that has no field', [
  `${fn(0)}/inputs/2/dataType`,
  { type: 'anonymousCustomType', anonymousCustomType: { fields: {} } },
]);

t('a Function input with a struct field of the Long type', [
  `${fn(0)}/inputs/2/dataType`,
  { type: 'anonymousCustomType', anonymousCustomType: { fields: { a: wrapped('long') } } },
]);

t('a Function list input with an anonymous custom type of an unknown kind', [
  `${fn(0)}/inputs/2/dataType`,
  { type: 'list', list: { elementsType: wrapped('weird') } },
]);

t('a parameter with conditional overrides', [`${pv('create-engagement', 'title')}/conditionalOverrides`, [{}]]);

t('a parameter with struct field validations', [
  `${pv('create-engagement', 'title')}/structFieldValidations`,
  { a: 1 },
]);

t('a parameter with a list length and a type that is not a list', [
  requiredOf('create-engagement', 'title'),
  wrapped('listLengthValidation'),
]);

t(
  'a parameter with a list length minimum above its maximum',
  [`${mp('create-engagement', 'title')}/type`, wrapped('stringList')],
  [requiredOf('create-engagement', 'title'), wrapped('listLengthValidation', { minLength: 5, maxLength: 2 })],
);

t(
  'a parameter with a list length that is not a whole number',
  [`${mp('create-engagement', 'title')}/type`, wrapped('stringList')],
  [requiredOf('create-engagement', 'title'), wrapped('listLengthValidation', { minLength: -1 })],
);

t(
  'a parameter with a list length that is not a number',
  [`${mp('create-engagement', 'title')}/type`, wrapped('stringList')],
  [requiredOf('create-engagement', 'title'), wrapped('listLengthValidation', { minLength: 'x' })],
);

t('a parameter with a required setting that V1 does not have', [
  requiredOf('create-engagement', 'title'),
  wrapped('weird'),
]);

t('a parameter with maybeCreateObjectOption', [
  `${mp('set-engagement-status', 'objectToModifyParameter')}/type/objectReference/maybeCreateObjectOption`,
  { x: 1 },
]);

t('a parameter of an Object Type that does not exist', [
  `${mp('set-engagement-status', 'objectToModifyParameter')}/type/objectReference/objectTypeId`,
  'Nope',
]);

t('a parameter of the Long type', [`${mp('create-engagement', 'title')}/type`, wrapped('long')]);

t('a parameter of the Interface reference type', [
  `${mp('create-engagement', 'title')}/type`,
  wrapped('interfaceReference'),
]);

t('a parameter of a type that V1 does not know', [`${mp('create-engagement', 'title')}/type`, wrapped('weird')]);

t('a struct parameter with no field', [
  `${mp('create-struct-probe', 'relationship')}/type/struct/structFieldTypes`,
  {},
]);

t('a struct parameter field of the Long type', [
  `${mp('create-struct-probe', 'relationship')}/type/struct/structFieldTypes`,
  { a: wrapped('long') },
]);

t('allowed values for groups', [allowedOf('create-engagement', 'title'), wrapped('multipassGroup')]);

t('allowed values of a kind that V1 does not know', [allowedOf('create-engagement', 'title'), wrapped('weird')]);

t('allowed values with a body of another kind', [
  allowedOf('create-engagement', 'title'),
  { type: 'text', text: wrapped('weird') },
]);

t('allowed values for an Object Set parameter filter', [
  allowedOf('set-engagement-status', 'objectToModifyParameter'),
  { type: 'objectQuery', objectQuery: wrapped('objectQuery', { objectSet: {} }) },
]);

t('allowed values for users with a group filter', [
  allowedOf('create-engagement', 'title'),
  { type: 'user', user: wrapped('user', { filter: [{}] }) },
]);

t('allowed values that do not fit the parameter type', [
  allowedOf('create-engagement', 'amount'),
  { type: 'text', text: wrapped('text') },
]);

t('text allowed values with a minimum length that is not a number', [
  allowedOf('create-engagement', 'title'),
  { type: 'text', text: wrapped('text', { minLength: 'x' }) },
]);

t('text allowed values with a regex that is not a string', [
  allowedOf('create-engagement', 'title'),
  { type: 'text', text: wrapped('text', { regex: { regex: 5 } }) },
]);

t('oneOf allowed values with a static value of a type that V1 does not know', [
  allowedOf('create-engagement', 'title'),
  { type: 'oneOf', oneOf: wrapped('oneOf', { labelledValues: [{ value: wrapped('weird', 1) }] }) },
]);

t('oneOf allowed values with a static value that does not fit', [
  allowedOf('create-engagement', 'title'),
  { type: 'oneOf', oneOf: wrapped('oneOf', { labelledValues: [{ value: wrapped('integer', 'x') }] }) },
]);

t('oneOf allowed values with a wrapped static value that does not fit', [
  allowedOf('create-engagement', 'title'),
  { type: 'oneOf', oneOf: wrapped('oneOf', { labelledValues: [{ value: wrapped('date', { dateValue: 5 }) }] }) },
]);

t('oneOf allowed values with a list value that does not fit', [
  allowedOf('create-engagement', 'title'),
  { type: 'oneOf', oneOf: wrapped('oneOf', { labelledValues: [{ value: wrapped('stringList', { strings: [1] }) }] }) },
]);

t('range allowed values with a bound that is not a static value', [
  allowedOf('create-engagement', 'amount'),
  { type: 'range', range: wrapped('range', { minimum: { value: { type: 'weird' } } }) },
]);

t('range allowed values with a bound that is a Boolean', [
  allowedOf('create-engagement', 'amount'),
  { type: 'range', range: wrapped('range', { maximum: { value: wrapped('staticValue', wrapped('boolean', true)) } }) },
]);

t(
  'datetime allowed values with a relative bound',
  addParameter('create-engagement', 'day', wrapped('date'), {
    type: 'datetime',
    datetime: wrapped('datetime', { minimum: { value: wrapped('relative') } }),
  }),
);

t('an Action Type with a Function rule and another rule', [
  `${at('close-account-action')}/actionTypeLogic/logic/rules/1`,
  { type: 'deleteObjectRule' },
]);

t('an Action Type with a Function rule for a Function that the version does not have', [
  `${logicRule('close-account-action')}/functionRule/functionRid`,
  'nope',
]);

t(
  '2 Action Types with 1 API name',
  copy(`ir/ontology/actionTypes/${NS}create-account`, 'ir/ontology/actionTypes/copy'),
);

t('an Action Type with a rule that V1 does not know', [logicRule('create-engagement'), wrapped('weird')]);

t('an Action Type with a Scenario rule', [logicRule('create-engagement'), wrapped('scenarioRule')]);

t('an add rule on an Object Type with edits off', noFunctions, [
  `${ot('Engagement')}/entityMetadata/arePatchesEnabled`,
  false,
]);

t(
  'a modify rule on an Object Type with edits off',
  noFunctions,
  [`${ot('Engagement')}/entityMetadata/arePatchesEnabled`, false],
  [`ir/ontology/actionTypes/${NS}create-engagement`, DEL],
);

t(
  'a delete rule on an Object Type with edits off',
  noFunctions,
  [`${ot('Account')}/entityMetadata/arePatchesEnabled`, false],
  [`ir/ontology/actionTypes/${NS}create-account`, DEL],
  [`ir/ontology/actionTypes/${NS}set-account-phase`, DEL],
  [`ir/ontology/actionTypes/${NS}copy-account-phase`, DEL],
);

t('an add rule on an Object Type that the Ontology does not have', [
  `${logicRule('create-engagement')}/addObjectRule/objectTypeId`,
  'Nope',
]);

t('an add rule that maps a Property that the Object Type does not have', [
  `${logicRule('create-engagement')}/addObjectRule/propertyValues/nope`,
  param('title'),
]);

t('an add rule that maps a struct Property in propertyValues', [
  `${logicRule('create-struct-probe')}/addObjectRule/propertyValues/relationship`,
  param('relationship'),
]);

t('an add rule with struct fields on a Property that is not a struct', [
  `${logicRule('create-engagement')}/addObjectRule/structFieldValues/title`,
  { a: {} },
]);

t('an add rule with struct fields that map a value that is not a struct parameter field', [
  `${logicRule('create-struct-probe')}/addObjectRule/structFieldValues/relationship/label`,
  param('title'),
]);

t('an add rule with struct fields that map another field', [
  `${logicRule('create-struct-probe')}/addObjectRule/structFieldValues/relationship/label/structParameterFieldValue/structFieldApiName`,
  'since',
]);

t('an add rule with struct fields from 2 parameters', [
  `${logicRule('create-struct-probe')}/addObjectRule/structFieldValues/relationship/since/structParameterFieldValue/parameterId`,
  'measures',
]);

t('an add rule with struct fields and no field', [
  `${logicRule('create-struct-probe')}/addObjectRule/structFieldValues/relationship`,
  {},
]);

t(
  'an add rule with struct fields from a parameter that is not a struct',
  [
    `${logicRule('create-struct-probe')}/addObjectRule/structFieldValues/relationship/label/structParameterFieldValue/parameterId`,
    'probeId',
  ],
  [
    `${logicRule('create-struct-probe')}/addObjectRule/structFieldValues/relationship/since/structParameterFieldValue/parameterId`,
    'probeId',
  ],
);

t('an add rule that does not map each field of a struct Property', [
  `${logicRule('create-struct-probe')}/addObjectRule/structFieldValues/relationship/since`,
  DEL,
]);

t('an add rule that maps a field that the struct Property does not have', [
  `${logicRule('create-struct-probe')}/addObjectRule/structFieldValues/relationship/extra`,
  {
    type: 'structParameterFieldValue',
    structParameterFieldValue: { parameterId: 'relationship', structFieldApiName: 'extra' },
  },
]);

t('an add rule with a struct parameter that has a field the Property does not have', [
  `${mp('create-struct-probe', 'relationship')}/type/struct/structFieldTypes/extra`,
  wrapped('string'),
]);

t('an add rule with a struct parameter that lacks a field of the Property', [
  `${mp('create-struct-probe', 'relationship')}/type/struct/structFieldTypes/since`,
  DEL,
]);

t('an add rule with a struct parameter of another field type', [
  `${mp('create-struct-probe', 'relationship')}/type/struct/structFieldTypes/since`,
  wrapped('string'),
]);

t('a modify rule on a parameter that the Action Type does not have', [
  `${logicRule('set-engagement-status')}/modifyObjectRule/objectToModify`,
  'nope',
]);

t('a modify rule on a parameter that is not an Object reference', [
  `${logicRule('set-engagement-status')}/modifyObjectRule/objectToModify`,
  'status',
]);

t('a rule value of a type that V1 does not know', [
  `${logicRule('create-engagement')}/addObjectRule/propertyValues/title`,
  wrapped('weird'),
]);

t('a rule value that is an Interface parameter Property value', [
  `${logicRule('create-engagement')}/addObjectRule/propertyValues/title`,
  wrapped('interfaceParameterPropertyValue'),
]);

t('a rule value that reads a Property that the Object does not have', [
  `${logicRule('copy-account-phase')}/modifyObjectRule/propertyValues/status/objectParameterPropertyValue/propertyTypeId`,
  'nope',
]);

t('a link rule on a Link Type that does not exist', linkAction(linkRule({ linkTypeId: 'nope' })));

t('a link rule on a one-to-many Link Type', linkAction(linkRule({ linkTypeId: 'account-to-engagements' })));

t(
  'a link rule on Object Types that the Link Type does not join',
  linkAction(linkRule({ sourceObject: 'objectToModifyParameter', targetObject: 'objectToModifyParameter' })),
);

t('a default value of a kind that V1 does not have', [
  `${pv('set-account-phase', 'viewers')}/defaultValidation/display/prefill`,
  wrapped('weird'),
]);

t('a default value that reads a parameter that does not exist', [
  `${pv('set-account-phase', 'viewers')}/defaultValidation/display/prefill/objectParameterPropertyValue/parameterId`,
  'nope',
]);

t('a default value that reads a parameter that is not an Object reference', [
  `${pv('set-account-phase', 'viewers')}/defaultValidation/display/prefill/objectParameterPropertyValue/parameterId`,
  'phase',
]);

t('a default value that reads a Property that the Object does not have', [
  `${pv('set-account-phase', 'viewers')}/defaultValidation/display/prefill/objectParameterPropertyValue/propertyTypeId`,
  'nope',
]);

t('a criterion with a comparison operator that V1 does not have', [
  criterion('create-engagement'),
  comparison('WEIRD', param('title'), text('x')),
]);

t('a criterion with a condition that V1 does not know', [criterion('create-engagement'), wrapped('weird')]);

t('a criterion on markings', [criterion('create-engagement'), wrapped('markings')]);

t('a criterion with a regex on a person value', [
  criterion('create-engagement'),
  { type: 'regex', regex: { value: person(userId), regex: 'x' } },
]);

t('a criterion with a regex that is not a string', [
  criterion('create-engagement'),
  { type: 'regex', regex: { value: param('title'), regex: 5 } },
]);

t('a criterion with a condition value that V1 does not know', [
  criterion('create-engagement'),
  comparison('EQUALS', wrapped('weird'), text('x')),
]);

t('a criterion with an Interface parameter Property value', [
  criterion('create-engagement'),
  comparison('EQUALS', wrapped('interfaceParameterPropertyValue'), text('x')),
]);

t('a criterion with a length that is not a parameterId', [
  criterion('create-engagement'),
  comparison('EQUALS', wrapped('parameterLength', wrapped('weird')), text('x')),
]);

t('a criterion with the length of a parameter that is not a list', [
  criterion('create-engagement'),
  comparison('EQUALS', wrapped('parameterLength', param('title')), text('x')),
]);

t('a criterion with a person value that is not an object', [
  criterion('create-engagement'),
  comparison('EQUALS', { type: 'userProperty', userProperty: 5 }, text('x')),
]);

t('a criterion with a person value with an unknown key', [
  criterion('create-engagement'),
  comparison('EQUALS', { type: 'userProperty', userProperty: { other: 1 } }, text('x')),
]);

t('a criterion with a person other than the current user', [
  criterion('create-engagement'),
  comparison('EQUALS', { type: 'userProperty', userProperty: { userId: { type: 'other' } } }, text('x')),
]);

t('a criterion with a person value that V1 does not know', [
  criterion('create-engagement'),
  comparison('EQUALS', person(wrapped('username')), text('x')),
]);

t('a criterion with a person comparison and an operator that V1 does not have', [
  criterion('create-engagement'),
  comparison('LESS_THAN', person(userId), param('title')),
]);

t('a criterion with a comparison of 2 person values', [
  criterion('create-engagement'),
  comparison('EQUALS', person(userId), person(userId)),
]);

t('a criterion with user.permissions and an operator other than INTERSECTS', [
  criterion('create-engagement'),
  comparison('EQUALS', person(groupIds), param('title')),
]);

t('a criterion with a person value and a value that is not a String', [
  criterion('create-engagement'),
  comparison('EQUALS', person(userId), param('amount')),
]);

t('datasources that are not a list', [`${ot('Account')}/datasources`, {}]);

t('a datasource that is not an object', [`${ot('Account')}/datasources/0`, 5]);

t('propertySecurityGroups outside the body of a datasource', [
  `${ot('Account')}/datasources/0/propertySecurityGroups`,
  {},
]);

t('a datasource with no body for its type', [`${ot('Account')}/datasources/0/datasource/type`, 'weird']);

t('a datasource with an unknown key', [`${ot('Account')}/datasources/0/datasource/extra`, 1]);

t('propertySecurityGroups with no list of groups', [
  `${ot('Account')}/datasources/0/datasource/datasetV3/propertySecurityGroups`,
  {},
]);

t('propertySecurityGroups with no group', [
  `${ot('Account')}/datasources/0/datasource/datasetV3/propertySecurityGroups/groups`,
  [],
]);

t('propertySecurityGroups with an unknown key', [
  `${ot('Account')}/datasources/0/datasource/datasetV3/propertySecurityGroups/extra`,
  1,
]);

t('a security group that is not an object', [group(0), 5]);

t('2 object security policies', copy(group(0), group(1)));

t('a security group of a type that V1 does not have', [`${group(0)}/type`, wrapped('weird')]);

t('a security group with an unknown key', [`${group(0)}/extra`, 1]);

t('a primaryKey group type with an unknown key', [`${group(0)}/type/extra`, 1]);

t('a primaryKey group type with no body', [`${group(0)}/type`, { type: 'primaryKey' }]);

t('a primaryKey group type with a body that has a key', [`${group(0)}/type/primaryKey`, { x: 1 }]);

t('a security that is not an object', [`${group(0)}/security`, 5]);

t('a security of an unknown type', [`${group(0)}/security/type`, 'weird']);

t('a security with an unknown key', [`${group(0)}/security/extra`, 1]);

t('a mandatoryOnly security that is not an object', [
  `${group(0)}/security`,
  { type: 'mandatoryOnly', mandatoryOnly: 5 },
]);

t('a mandatoryOnly security with an unknown key', [
  `${group(0)}/security`,
  { type: 'mandatoryOnly', mandatoryOnly: { policy: {}, extra: 1 } },
]);

t('a mandatoryOnly security with a policy that reads markings', [
  `${group(0)}/security`,
  {
    type: 'mandatoryOnly',
    mandatoryOnly: { policy: { markings: { m: 1 }, assumedMarkings: [], assumedMarkingsV2: {} } },
  },
]);

t('a granular security with no viewPolicy', [`${group(0)}/security/granular`, {}]);

t('a granular security with an unknown key', [`${group(0)}/security/granular/extra`, 1]);

t('a viewPolicy with an unknown key', [`${group(0)}/security/granular/viewPolicy/extra`, 1]);

t('a mandatory policy that is not markings', [`${group(0)}/security/granular/viewPolicy/additionalMandatory`, 5]);

t('a mandatory policy with an unknown key', [`${group(0)}/security/granular/viewPolicy/additionalMandatory/extra`, 1]);

t('a viewPolicy with no condition', [`${group(0)}/security/granular/viewPolicy/granularPolicyCondition`, DEL]);

t('a condition that is not an object', [cond(0), 5]);

t('a condition that uses not', [cond(0), wrapped('not')]);

t('a condition on markings', [cond(0), wrapped('markings')]);

t('a condition of a type that V1 does not know', [cond(0), wrapped('weird')]);

t('an and with no list of conditions', [cond(0), { type: 'and' }]);

t('an and with no condition', [cond(0), { type: 'and', and: { conditions: [] } }]);

t('an or with an unknown key', [`${group(0)}/security/granular/viewPolicy/granularPolicyCondition/or/extra`, 1]);

t('a condition with an unknown key', [`${group(0)}/security/granular/viewPolicy/granularPolicyCondition/extra`, 1]);

t('a comparison with an unknown key', [`${cond(0)}/comparison/extra`, 1]);

t('a comparison that is not an object', [`${cond(0)}/comparison`, 5]);

t('a comparison with an operator that V1 does not have', [`${cond(0)}/comparison/operator`, 'LESS_THAN']);

t('a comparison with 2 person sides', [`${cond(0)}/comparison/right`, policyPerson(userId)]);

t('a comparison with no person side', [`${cond(0)}/comparison/left`, constant('a')]);

t('a comparison of user.permissions with EQUAL', [`${cond(0)}/comparison/operator`, 'EQUAL']);

t('a comparison of user.permissions with the sides swapped', [
  cond(0),
  {
    type: 'comparison',
    comparison: { operator: 'SUPERSET_OF', left: constant('admin'), right: policyPerson(groupIds) },
  },
]);

t('a comparison of user.permissions that swaps to superset of', [`${cond(0)}/comparison/operator`, 'SUBSET_OF']);

t('a comparison side that is not an object', [`${cond(0)}/comparison/left`, 5]);

t('a comparison side with an unknown key', [`${cond(0)}/comparison/left/extra`, 1]);

t('a comparison side of an unknown type', [`${cond(0)}/comparison/right`, wrapped('weird')]);

t('a comparison side that reads a Property that the Object Type does not have', [
  `${cond(1)}/comparison/left/property`,
  'nope',
]);

t('a comparison side that reads a Property that is not a String', [
  `${prop('Account', 'ownerId')}/type`,
  wrapped('integer'),
]);

t('a constant that is a Boolean', [`${cond(0)}/comparison/right/constant`, { type: 'boolean', boolean: true }]);

t('a constant that is not a String', [`${cond(0)}/comparison/right/constant`, { type: 'strings', strings: [1] }]);

t('a constant with an unknown key', [`${cond(0)}/comparison/right/constant/extra`, 1]);

t('a person value that is not an object', [`${cond(0)}/comparison/left/userProperty`, 5]);

t('a person value of the username', [`${cond(0)}/comparison/left/userProperty`, wrapped('username')]);

t('a person value of the group names', [`${cond(0)}/comparison/left/userProperty`, wrapped('groupNames')]);

t('a person value that V1 does not know', [`${cond(0)}/comparison/left/userProperty`, wrapped('weird')]);

t('a person value of the user ID with no body', [`${cond(0)}/comparison/left/userProperty`, { type: 'userId' }]);

t('a person value of the user ID with a key in its body', [
  `${cond(0)}/comparison/left/userProperty`,
  { type: 'userId', userId: { x: 1 } },
]);

t('a Person attribute with no body', [`${cond(0)}/comparison/left/userProperty`, { type: 'userAttributes' }]);

t('a Person attribute with an unknown key', [
  `${cond(0)}/comparison/left/userProperty`,
  wrapped('userAttributes', { attributeKey: 'a', extra: 1 }),
]);

t('a Person attribute with an empty key', [
  `${cond(0)}/comparison/left/userProperty`,
  wrapped('userAttributes', { attributeKey: '' }),
]);

p('a property group with an unknown key', [`${group(1)}/extra`, 1]);

p('a property group type with an unknown key', [`${group(1)}/type/extra`, 1]);

p('a property group type with no name', [`${group(1)}/type/property`, {}]);

p('a property group type with a body that has an unknown key', [`${group(1)}/type/property/extra`, 1]);

p('a property group type with another name', [`${group(1)}/type/property/name`, 'other']);

p('a property group with no list of Properties', [`${group(1)}/properties`, 5]);

p('a property group that holds the primary key', [`${group(1)}/properties`, ['accountId']]);

p('a property group that holds a Property that the Object Type does not have', [`${group(1)}/properties`, ['nope']]);

p('a Property in 2 property groups', [`${group(2)}/properties`, ['name', 'notes']]);

p('a property group with a security that is not an object', [`${group(1)}/security`, 5]);

p('a property group with a condition that uses not', [
  `${group(1)}/security/granular/viewPolicy/granularPolicyCondition`,
  wrapped('not'),
]);

t(
  '2 faults: the value types come before the Object Types',
  ['ir/valueTypes', { valueTypes: [{}] }],
  ['ir/ontology/objectTypes', 5],
);

t(
  '2 faults in 1 Object Type: the API name comes before the status',
  [`${oty('Account')}/apiName`, 5],
  [`${oty('Account')}/status`, { type: 'weird' }],
);

t(
  '2 faults: an Object Type comes before an Action Type',
  [`${oty('Account')}/status`, { type: 'weird' }],
  [`${at('create-engagement')}/metadata/apiName`, 5],
);

const derivedBody = (key: string) =>
  `${ot('Account')}/datasources/0/datasource/derived/definition/aggregatedProperties/${key}`;

d('a derived definition of a kind that V1 does not know', (doc) => {
  const definition = `${ot('Account')}/datasources/0/datasource/derived/definition`;

  put(doc, definition, { type: 'weird', weird: structuredClone(get(doc, `${definition}/aggregatedProperties`)) });
});

d('a derived datasource that maps no Property', [derivedBody('propertyTypeMapping'), {}]);

d('a link definition of a kind that V1 does not know', [derivedBody('linkDefinition'), wrapped('weird')]);

d('a hop that is not a searchAround step', [`${derivedBody('linkDefinition')}/multiHopLink/steps/0/type`, 'weird']);

d('a hop with a side that is not SOURCE or TARGET', [
  `${derivedBody('linkDefinition')}/multiHopLink/steps/0/searchAround/linkTypeSide`,
  'SIDEWAYS',
]);

d('a collectList with no limit', [
  `${derivedBody('propertyTypeMapping')}/balance`,
  wrapped('collectList', { linkedProperty: wrapped('propertyType', 'amount') }),
]);

v('a value type with a status that V1 does not know', ['ir/valueTypes/valueTypes/0/metadata/status', wrapped('weird')]);

describe('compile refusals', () => {
  it('the 4 twin IRs compile with no refusal', () => {
    for (const which of ['policies', 'property', 'derived', 'valueTypes'] as const)
      expect(() => compileOrThrow(input(base(which)))).not.toThrow();
  });

  for (const refusal of cases) {
    it(refusal.name, () => {
      let answer: unknown;

      try {
        compileOrThrow(input(edited(refusal)));

        answer = { compiled: true };
      } catch (error) {
        answer = { name: (error as Error).name, message: (error as Error).message };
      }

      expect(answer).toMatchSnapshot();
    });
  }
});

function edited({ base: which, edits }: Case): Doc {
  const doc = base(which);

  for (const edit of edits) {
    if (typeof edit === 'function') edit(doc);
    else put(doc, edit[0], edit[1]);
  }

  return doc;
}

const twinFile = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../twin/ir/${name}.json`, import.meta.url), 'utf8'));

function base(which: Base): Doc {
  switch (which) {
    case 'policies':
      return { ir: policiesIr(), functions: twinFunctions('0.6.3'), rid: ONTOLOGY_RID };
    case 'property':
      return { ir: propertyPoliciesIr(), functions: undefined, rid: ONTOLOGY_RID };
    case 'derived':
      return { ir: twinFile('derived'), functions: undefined, rid: ONTOLOGY_RID };
    case 'valueTypes':
      return { ir: twinFile('value-types'), functions: undefined, rid: ONTOLOGY_RID };
  }
}

function input(doc: Doc): Parameters<typeof compileOntology>[0] {
  const { osdkSet } = stored(policiesIr());

  return {
    version: 1,
    ir: doc.ir,
    metadata: emptyOntology(doc.rid).metadata,
    osdkSet,
    ...(doc.functions === undefined ? {} : { functions: doc.functions as StoredFunctions }),
  };
}

let handleInput: HandleInput;
let token: string;

beforeAll(async () => {
  const issuer = await createTestIssuer(testSettings.auth);

  handleInput = { ...testInput, keys: issuer.keys };

  token = await issuer.github({ environment: undefined, sub: 'repo:example/test-app:pull_request' });
});

const publishRefusals = cases.filter((refusal) => {
  if (refusal.edits.some((edit) => Array.isArray(edit) && edit[0] === 'rid')) return false;

  try {
    compileOrThrow(input(edited(refusal)));

    return false;
  } catch {
    return true;
  }
});

describe('service/publish#route: the answer to an IR that compile refuses', () => {
  for (const refusal of publishRefusals) {
    it(refusal.name, async () => {
      const { ir, functions } = edited(refusal);

      const body = {
        product: 'test',
        ir,
        schemaMigrations: { migrations: [] },
        osdkSet: input({ ir, functions, rid: ONTOLOGY_RID }).osdkSet,
        grants: twinGrantsFile(),
        validateOnly: true,
        ...(functions === undefined ? {} : { functions }),
      };

      const response = await handle(
        new Request('http://localhost/api/ontology-service/v1/publish', {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        }),
        handleInput,
      );

      expect(errorAnswer({ status: response.status, body: await response.json() })).toMatchSnapshot();
    });
  }
});
