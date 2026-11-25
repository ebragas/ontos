import { each, type Fallible } from '../errors/index.ts';
import type { CompiledObjectType, CompiledProperty, Policy, PropertyApiName } from './compiled/index.ts';
import { CompileError } from './compiled/stored.ts';
import { storedProperty } from './derived/ir.ts';
import { isRecord, type JsonRecord } from './model/shape.ts';
import { compileCondition, onlyKeys, type Refuse } from './policies/conditions.ts';

export function* compilePolicies<Derived>(
  datasources: unknown,
  objectType: CompiledObjectType<Derived>,
): Fallible<CompiledObjectType<Derived>, CompileError> {
  const owner = `Object Type ${objectType.apiName}`;
  const policies: { readonly name: string; readonly policy: Policy }[] = [];
  const properties = new Map<PropertyApiName, { readonly name: string; readonly policy: Policy | undefined }>();

  for (const group of yield* groupsOf(datasources, owner)) {
    const name = String(group['rid']);
    const kind = isRecord(group['type']) ? group['type']['type'] : undefined;

    if (kind === 'property') {
      const refuse = function* (feature: string): Fallible<never, CompileError> {
        return yield new CompileError(`${owner} has the property security policy '${name}', which ${feature}.`);
      };

      const held = yield* propertyGroup(group, name, objectType, refuse);
      const condition = yield* viewCondition(group['security'], refuse);
      const policy = condition === OPEN ? undefined : yield* compileCondition(condition, objectType, refuse);

      for (const property of held) {
        const other = properties.get(property);

        if (other) {
          return yield new CompileError(
            `${owner} has the Property ${property} in 2 property security policies, '${other.name}' and '${name}'. A Property is in at most 1 property security policy.`,
          );
        }

        properties.set(property, { name, policy });
      }

      continue;
    }

    const refuse = function* (feature: string): Fallible<never, CompileError> {
      return yield new CompileError(`${owner} has the object security policy '${name}', which ${feature}.`);
    };

    if (kind !== 'primaryKey')
      yield* refuse(
        `has the security group type ${String(kind)}. A V1 security group is a primaryKey group or a property group`,
      );

    yield* primaryKeyGroup(group, refuse);

    const condition = yield* viewCondition(group['security'], refuse);

    if (condition !== OPEN) policies.push({ name, policy: yield* compileCondition(condition, objectType, refuse) });
  }

  if (policies.length > 1) {
    return yield new CompileError(
      `${owner} has 2 object security policies, ${policies.map(({ name }) => `'${name}'`).join(' and ')}. An Object Type has at most 1 object security policy.`,
    );
  }

  const [only] = policies;

  const withPolicy = (property: CompiledProperty): CompiledProperty => {
    const policy = properties.get(property.apiName)?.policy;

    return policy ? { ...property, policy } : property;
  };

  const masked = [...properties.values()].some(({ policy }) => policy !== undefined);

  return {
    ...objectType,
    ...(only ? { policy: only.policy } : {}),
    ...(masked
      ? {
          properties: new Map([...objectType.properties].map(([apiName, property]) => [apiName, withPolicy(property)])),
        }
      : {}),
  };
}

function* primaryKeyGroup(group: JsonRecord, refuse: Refuse): Fallible<void, CompileError> {
  yield* onlyKeys(group, ['rid', 'security', 'type', 'properties'], 'a security group', refuse);

  const type = group['type'] as JsonRecord;

  yield* onlyKeys(type, ['type', 'primaryKey'], 'a primaryKey group type', refuse);

  const body = type['primaryKey'];

  if (!isRecord(body)) return yield* refuse('has a primaryKey group type with no body');

  yield* onlyKeys(body, [], 'a primaryKey group type', refuse);
}

function* propertyGroup(
  group: JsonRecord,
  name: string,
  objectType: CompiledObjectType<unknown>,
  refuse: Refuse,
): Fallible<PropertyApiName[], CompileError> {
  yield* onlyKeys(group, ['rid', 'security', 'type', 'properties'], 'a security group', refuse);

  const type = group['type'] as JsonRecord;

  yield* onlyKeys(type, ['type', 'property'], 'a property group type', refuse);

  const body = type['property'];

  if (!isRecord(body) || typeof body['name'] !== 'string')
    return yield* refuse('has a property group type with no name');

  yield* onlyKeys(body, ['name'], 'a property group type', refuse);

  if (body['name'] !== name) yield* refuse(`has a property group type with the name '${body['name']}'`);

  const held = group['properties'];

  if (!Array.isArray(held) || !held.every((each) => typeof each === 'string'))
    return yield* refuse('has no list of Properties');

  for (const property of held as string[]) {
    if (property === objectType.primaryKey.apiName)
      yield* refuse(`holds the primary key ${property}. The primary key is in no property security policy`);

    if (!(yield* storedProperty(objectType, property, `in the property security policy '${name}'`)))
      yield* refuse(`holds the Property ${property}, which the Object Type does not have`);
  }

  return held as string[];
}

function* groupsOf(datasources: unknown, owner: string): Fallible<JsonRecord[], CompileError> {
  if (datasources === undefined) return [];

  if (!Array.isArray(datasources)) return yield new CompileError(`${owner} has datasources that are not a list.`);

  return (yield* each(datasources, function* (entry: unknown): Fallible<JsonRecord[], CompileError> {
    const datasource = isRecord(entry) ? entry['datasource'] : undefined;

    if (!isRecord(entry) || !isRecord(datasource))
      return yield new CompileError(`${owner} has a datasource that is not an object.`);

    if ('propertySecurityGroups' in entry || 'propertySecurityGroups' in datasource) {
      return yield new CompileError(`${owner} has propertySecurityGroups outside the body of its datasource.`);
    }

    const body = typeof datasource['type'] === 'string' ? datasource[datasource['type']] : undefined;

    if (!isRecord(body)) return yield new CompileError(`${owner} has a datasource with no body for its type.`);

    const other = Object.keys(datasource).find((key) => key !== 'type' && key !== datasource['type']);

    if (other !== undefined) return yield new CompileError(`${owner} has a datasource with the unknown key ${other}.`);

    const securityGroups = body['propertySecurityGroups'];

    if (securityGroups === undefined) return [];

    if (!isRecord(securityGroups) || !Array.isArray(securityGroups['groups']))
      return yield new CompileError(`${owner} has propertySecurityGroups with no list of groups.`);

    if ((securityGroups['groups'] as unknown[]).length === 0)
      return yield new CompileError(`${owner} has propertySecurityGroups with no group.`);

    const unknown = Object.keys(securityGroups).find((key) => key !== 'groups');

    if (unknown !== undefined)
      return yield new CompileError(`${owner} has propertySecurityGroups with the unknown key ${unknown}.`);

    return yield* each(securityGroups['groups'] as unknown[], function* (group): Fallible<JsonRecord, CompileError> {
      if (!isRecord(group)) return yield new CompileError(`${owner} has a security group that is not an object.`);

      return group;
    });
  })).flat();
}

const OPEN = Symbol('open');

function* viewCondition(security: unknown, refuse: Refuse): Fallible<unknown, CompileError> {
  if (!isRecord(security)) return yield* refuse('has a security that is not an object');

  const type = security['type'];

  if (type !== 'mandatoryOnly' && type !== 'granular')
    return yield* refuse(`has the security type ${String(type)}. A V1 security is granular or mandatoryOnly`);

  yield* onlyKeys(security, ['type', type], 'a security', refuse);

  if (type === 'mandatoryOnly') {
    const mandatory = security['mandatoryOnly'];

    if (!isRecord(mandatory)) return yield* refuse('has a mandatoryOnly security that is not an object');

    yield* onlyKeys(mandatory, ['policy'], 'a mandatoryOnly security', refuse);

    yield* mandatoryPolicy(mandatory['policy'], refuse);

    return OPEN;
  }

  const granular = security['granular'];
  const viewPolicy = isRecord(granular) ? granular['viewPolicy'] : undefined;

  if (!isRecord(granular) || !isRecord(viewPolicy)) return yield* refuse('has a granular security with no viewPolicy');

  yield* onlyKeys(granular, ['viewPolicy'], 'a granular security', refuse);

  yield* onlyKeys(viewPolicy, ['granularPolicyCondition', 'additionalMandatory'], 'a viewPolicy', refuse);

  yield* mandatoryPolicy(viewPolicy['additionalMandatory'], refuse);

  const condition = viewPolicy['granularPolicyCondition'];

  if (!isRecord(condition)) return yield* refuse('has no condition');

  return isOpen(condition) ? OPEN : condition;
}

function* mandatoryPolicy(policy: unknown, refuse: Refuse): Fallible<void, CompileError> {
  if (isRecord(policy))
    yield* onlyKeys(policy, ['markings', 'assumedMarkings', 'assumedMarkingsV2'], 'a mandatory policy', refuse);

  const markings = isRecord(policy) ? policy['markings'] : undefined;
  const assumed = isRecord(policy) ? policy['assumedMarkings'] : undefined;
  const assumedV2 = isRecord(policy) ? policy['assumedMarkingsV2'] : undefined;

  if (!isRecord(markings) || !Array.isArray(assumed) || !isRecord(assumedV2)) {
    return yield* refuse('has a mandatory policy that is not markings, assumedMarkings, and assumedMarkingsV2');
  }

  if (Object.keys(markings).length > 0 || assumed.length > 0 || Object.keys(assumedV2).length > 0)
    yield* refuse('reads markings. V1 has no markings');
}

function isOpen(condition: JsonRecord): boolean {
  const body = condition['and'];

  return (
    Object.keys(condition).length === 2 &&
    condition['type'] === 'and' &&
    isRecord(body) &&
    Object.keys(body).length === 1 &&
    Array.isArray(body['conditions']) &&
    body['conditions'].length === 0
  );
}
