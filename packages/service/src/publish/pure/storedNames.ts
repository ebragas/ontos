import { camelCaseOf } from '../../ontology/index.ts';

export const LINK_ID_PREFIX = 'linkId:';

export function extractedNameKeys(names: readonly string[]): Set<string> {
  const keys = new Set<string>();

  for (const entry of names) {
    keys.add(entry.startsWith(LINK_ID_PREFIX) ? `linkType:${camelCaseOf(entry.slice(LINK_ID_PREFIX.length))}` : entry);
  }

  return keys;
}

export function storedNameKeys(ir: unknown): Set<string> {
  const keys = new Set<string>();
  const ontology = field(ir, 'ontology');

  for (const block of values(field(ontology, 'objectTypes'))) {
    const objectType = field(block, 'objectType');
    const type = text(field(objectType, 'apiName'));

    if (type === undefined) continue;

    keys.add(`objectType:${type}`);

    for (const property of values(field(objectType, 'propertyTypes'))) {
      const name = text(field(property, 'apiName'));

      if (name !== undefined) keys.add(`property:${type}:${name}`);
    }
  }

  for (const block of values(field(ontology, 'linkTypes'))) {
    const linkType = field(block, 'linkType');
    const id = text(field(linkType, 'id'));

    if (id !== undefined) keys.add(`linkType:${camelCaseOf(id)}`);

    const definition = field(linkType, 'definition');
    const oneToMany = field(definition, 'oneToMany');

    addSide(keys, field(oneToMany, 'objectTypeRidOneSide'), field(oneToMany, 'oneToManyLinkMetadata'));

    addSide(keys, field(oneToMany, 'objectTypeRidManySide'), field(oneToMany, 'manyToOneLinkMetadata'));

    const manyToMany = field(definition, 'manyToMany');

    addSide(keys, field(manyToMany, 'objectTypeRidA'), field(manyToMany, 'objectTypeAToBLinkMetadata'));

    addSide(keys, field(manyToMany, 'objectTypeRidB'), field(manyToMany, 'objectTypeBToALinkMetadata'));
  }

  for (const block of values(field(ontology, 'actionTypes'))) {
    const name = text(field(field(field(block, 'actionType'), 'metadata'), 'apiName'));

    if (name !== undefined) keys.add(`actionType:${name}`);
  }

  return keys;
}

function addSide(keys: Set<string>, on: unknown, side: unknown): void {
  const type = text(on);
  const name = text(field(side, 'apiName'));

  if (type !== undefined && name !== undefined) keys.add(`link:${type}:${name}`);
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function values(value: unknown): unknown[] {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.values(value) : [];
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
