import type {
  CompiledOntology,
  CompiledPersonAttribute,
  Condition,
  ConditionValue,
  PersonAttributeDeclaration,
  PersonAttributeName,
  Policy,
} from '../compiled/index.ts';
import type { GrantsFile } from '../grantsFile.ts';
import { isRecord } from '../model/shape.ts';

type Declarations = Readonly<Record<PersonAttributeName, PersonAttributeDeclaration>>;

export function personAttributesOf(value: unknown): Declarations | undefined {
  if (!isRecord(value)) return undefined;

  const isString = (each: unknown): each is string => typeof each === 'string';

  const hasKeys = (record: Record<string, unknown>, keys: readonly string[]) =>
    Object.keys(record).length === keys.length && keys.every((key) => Object.hasOwn(record, key));

  const isDeclaration = (entry: unknown): entry is PersonAttributeDeclaration => {
    if (!isRecord(entry) || !hasKeys(entry, ['start', 'links'])) return false;

    const { start, links } = entry;

    return (
      isRecord(start) &&
      hasKeys(start, ['objectType', 'property']) &&
      isString(start['objectType']) &&
      isString(start['property']) &&
      Array.isArray(links) &&
      links.every(isString)
    );
  };

  return Object.values(value).every(isDeclaration) ? (value as Declarations) : undefined;
}

export function resolvePersonAttributes(
  compiled: CompiledOntology,
  grants: Pick<GrantsFile, 'personAttributes'> | null,
): ReadonlyMap<PersonAttributeName, CompiledPersonAttribute> {
  const resolved = new Map<PersonAttributeName, CompiledPersonAttribute>();

  for (const [name, declaration] of Object.entries(grants?.personAttributes ?? {})) {
    const attribute = resolve(compiled, name, declaration);

    if (typeof attribute !== 'string') resolved.set(name, attribute);
  }

  return resolved;
}

export function personAttributeProblems(
  compiled: CompiledOntology,
  grants: Pick<GrantsFile, 'personAttributes'>,
): string[] {
  const declarations = grants.personAttributes ?? {};

  const problems = Object.entries(declarations).flatMap(([name, declaration]) => {
    const attribute = resolve(compiled, name, declaration);

    return typeof attribute === 'string' ? [attribute] : [];
  });

  for (const [owner, names] of readers(compiled)) {
    for (const name of names) {
      if (!Object.hasOwn(declarations, name))
        problems.push(`${owner} reads the Person attribute ${name}, which personAttributes does not declare.`);
    }
  }

  return problems;
}

export function attributesRead(view: CompiledOntology): ReadonlySet<PersonAttributeName> {
  return new Set([...readers(view).values()].flatMap((names) => [...names]));
}

function readers(ontology: CompiledOntology): Map<string, Set<PersonAttributeName>> {
  const read = new Map<string, Set<PersonAttributeName>>();

  const add = (owner: string, names: Iterable<PersonAttributeName>) => {
    for (const name of names) read.set(owner, (read.get(owner) ?? new Set()).add(name));
  };

  for (const objectType of ontology.objectTypes.values()) {
    if (objectType.policy)
      add(`The object security policy of the Object Type ${objectType.apiName}`, policyNames(objectType.policy));

    for (const property of objectType.properties.values()) {
      if (property.policy)
        add(
          `The property security policy of the Property ${property.apiName} of ${objectType.apiName}`,
          policyNames(property.policy),
        );
    }
  }

  for (const action of ontology.actionTypes.values()) {
    add(
      `A Submission criterion of the Action Type ${action.apiName}`,
      action.criteria.flatMap(({ condition }) => conditionNames(condition)),
    );
  }

  return read;
}

function policyNames(policy: Policy): PersonAttributeName[] {
  if (policy.kind !== 'compare') return policy.conditions.flatMap(policyNames);

  return policy.person.kind === 'attribute' ? [policy.person.name] : [];
}

function conditionNames(condition: Condition): PersonAttributeName[] {
  const valueNames = (value: ConditionValue) =>
    value.kind === 'person' && value.fact.kind === 'attribute' ? [value.fact.name] : [];

  switch (condition.kind) {
    case 'true':
      return [];
    case 'and':
    case 'or':
      return condition.conditions.flatMap(conditionNames);
    case 'not':
      return conditionNames(condition.condition);
    case 'comparison':
      return [...valueNames(condition.left), ...valueNames(condition.right)];
    case 'regex':
      return valueNames(condition.value);
  }
}

function resolve(
  compiled: CompiledOntology,
  name: PersonAttributeName,
  { start, links }: PersonAttributeDeclaration,
): CompiledPersonAttribute | string {
  const what = `The Person attribute ${name}`;
  const startType = compiled.objectTypes.get(start.objectType);

  if (!startType) return `${what} starts at the Object Type ${start.objectType}, which the IR does not have.`;

  const property = startType.properties.get(start.property);

  if (!property)
    return `${what} starts at the Property ${start.property}, which the Object Type ${start.objectType} does not have.`;

  if (property.type.kind !== 'string')
    return `${what} starts at the Property ${start.property} of ${start.objectType}, which is not a String.`;

  const steps: CompiledPersonAttribute['steps'][number][] = [];
  let at = startType;

  for (const side of links) {
    const link = at.links.get(side);
    const target = link ? compiled.objectTypes.get(link.target) : undefined;

    if (!link || !target)
      return `${what} follows the Link side ${side}, which is not a side of the Object Type ${at.apiName}.`;

    steps.push({ via: link.via, target: { table: target.table, keyColumn: target.primaryKey.column } });

    at = target;
  }

  return {
    name,
    start: { table: startType.table, keyColumn: startType.primaryKey.column, userColumn: property.column },
    steps,
  };
}
