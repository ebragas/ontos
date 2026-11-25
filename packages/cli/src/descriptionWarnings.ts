import type { PublishedFunctions, PublishRequest } from '@ericbragas/ontos-service/publish';

type Json = Readonly<Record<string, unknown>>;

const entries = (value: unknown): [string, Json][] =>
  typeof value === 'object' && value !== null
    ? Object.entries(value).map(([key, entry]): [string, Json] => [key, (entry ?? {}) as Json])
    : [];

const byName = <T>(list: readonly (readonly [string, T])[]): (readonly [string, T])[] =>
  [...list].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

const blank = (value: unknown): boolean => typeof value !== 'string' || value.trim() === '';

const field = (value: Json | undefined, key: string): Json => (value?.[key] ?? {}) as Json;

const camelCase = (id: string): string => id.replace(/-([a-z0-9])/g, (_, letter: string) => letter.toUpperCase());

export function descriptionWarnings(ir: PublishRequest['ir'], functions: PublishedFunctions | undefined): string[] {
  const ontology = field(Object.fromEntries(Object.entries(ir)), 'ontology');
  const lines: string[] = [];

  for (const [key, entry] of byName(entries(ontology['objectTypes']))) {
    const objectType = field(entry, 'objectType');
    const apiName = typeof objectType['apiName'] === 'string' ? objectType['apiName'] : key;

    if (blank(field(objectType, 'displayMetadata')['description']))
      lines.push(`Object Type ${apiName} has no description.`);

    for (const [name, property] of byName(entries(objectType['propertyTypes']))) {
      if (blank(field(property, 'displayMetadata')['description']))
        lines.push(`Property ${apiName}.${name} has no description.`);
    }
  }

  for (const [key, entry] of byName(entries(ontology['linkTypes']))) {
    const linkType = field(entry, 'linkType');

    if (blank(linkType['description']))
      lines.push(
        `Link Type ${camelCase(typeof linkType['id'] === 'string' ? linkType['id'] : key)} has no description.`,
      );
  }

  const inputs = new Map(
    (functions?.discovered ?? []).map(
      (fn) =>
        [
          fn.locator.typescript?.functionName,
          fn.inputs.slice(fn.inputs[0]?.dataType.type === 'client' ? 1 : 0),
        ] as const,
    ),
  );

  for (const [key, entry] of byName(entries(ontology['actionTypes']))) {
    const actionType = field(entry, 'actionType');
    const metadata = field(actionType, 'metadata');
    const apiName = typeof metadata['apiName'] === 'string' ? metadata['apiName'] : key;

    if (blank(field(metadata, 'displayMetadata')['description']))
      lines.push(`Action Type ${apiName} has no description.`);

    const rules = field(field(actionType, 'actionTypeLogic'), 'logic')['rules'];

    const functionRule = (Array.isArray(rules) ? rules : [])
      .map((rule) => field(rule as Json, 'functionRule'))
      .find((rule) => rule['functionRid'] !== undefined);

    const parameters = functionRule
      ? (inputs.get(String(functionRule['functionRid'])) ?? []).map((input) => [input.name, input.description] as const)
      : entries(metadata['parameters']).map(
          ([id, parameter]) => [id, field(parameter, 'displayMetadata')['description']] as const,
        );

    for (const [id, description] of byName(parameters)) {
      if (blank(description)) lines.push(`Parameter ${id} of Action Type ${apiName} has no description.`);
    }
  }

  return lines;
}
