import { type Fallible } from '../../errors/index.ts';
import { CompileError } from '../compiled/stored.ts';

const RESERVED = new Set([
  'ontology',
  'object',
  'property',
  'link',
  'relation',
  'rid',
  'primarykey',
  'typeid',
  'ontologyobject',
]);

export function* checkReserved(apiName: string, what: string, name = apiName): Fallible<void, CompileError> {
  if (RESERVED.has(name.toLowerCase())) {
    return yield new CompileError(
      `The ${what} ${apiName} is a reserved word, in any case. An API name is never a reserved word.`,
    );
  }
}

const LINK_RULE = 'starts with a lowercase letter, has only letters and digits, and has 1 to 100 characters';

export function* checkLinkTypeApiName(apiName: string): Fallible<void, CompileError> {
  const what = 'Link Type API name';

  yield* checkReserved(apiName, what);

  if (!/^[a-z][A-Za-z0-9]{0,99}$/.test(apiName))
    return yield new CompileError(`The ${what} ${apiName} is not valid. A ${what} ${LINK_RULE}.`);
}

export function* checkLinkSideApiName(apiName: string, linkType: string): Fallible<void, CompileError> {
  const what = `Link side API name of Link Type ${linkType}:`;

  yield* checkReserved(apiName, what);

  if (!/^[a-z][A-Za-z0-9]{0,99}$/.test(apiName)) {
    return yield new CompileError(`The ${what} ${apiName} is not valid. A Link side API name ${LINK_RULE}.`);
  }
}

const STRUCT_FIELD_RULE =
  'A struct field API name starts with a lowercase letter, has only letters and digits, and has 1 to 100 characters.';

export function* checkStructFieldApiName(apiName: string, owner: string): Fallible<void, CompileError> {
  const what = `struct field API name of ${owner}:`;

  yield* checkReserved(apiName, what);

  if (!/^[a-z][A-Za-z0-9]{0,99}$/.test(apiName))
    return yield new CompileError(`The ${what} ${apiName} is not valid. ${STRUCT_FIELD_RULE}`);
}
