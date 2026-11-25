import { type Fallible } from '../../errors/index.ts';
import type {
  CompiledProperty,
  ObjectTypeApiName,
  ParameterId,
  PropertyApiName,
  Rule,
  RuleValue,
} from '../compiled/index.ts';
import { CompileError } from '../compiled/stored.ts';
import { storedProperty } from '../derived/ir.ts';
import { EDITS_RULE } from '../model/functions.ts';
import { camelCaseOf } from '../model/names.ts';
import { record, string, tag, type JsonRecord } from '../model/shape.ts';
import { staticValue } from '../parameters/allowed.ts';
import { own } from '../parameters/scalars.ts';
import {
  checkParameter,
  objectParameter,
  objectParameterProperty,
  type ActionTypeContext,
  type Parameters,
} from './context.ts';

const OUTSIDE_RULES: Readonly<Record<string, string>> = {
  addOrModifyObjectRuleV2: 'a Create or modify object rule',
  addOrModifyObjectRule: 'a Create or modify object rule',
  addInterfaceRule: 'an Interface rule',
  modifyInterfaceRule: 'an Interface rule',
  addInterfaceLinkRule: 'an Interface rule',
  addInterfaceLinkRuleV2: 'an Interface rule',
  deleteInterfaceLinkRule: 'an Interface rule',
  scenarioRule: 'a Scenario rule',
};

export function* compileRule(
  value: unknown,
  path: string,
  owner: string,
  parameters: Parameters,
  context: ActionTypeContext,
): Fallible<Rule, CompileError> {
  const kind = yield* tag(value, path);
  const body = yield* record((yield* record(value, path))[kind], `${path}.${kind}`);
  const bodyPath = `${path}.${kind}`;

  switch (kind) {
    case 'addObjectRule': {
      const objectType = yield* string(body['objectTypeId'], `${bodyPath}.objectTypeId`);

      yield* checkEditable(objectType, owner, context);

      return {
        kind: 'addObject',
        objectType,
        properties: yield* ruleProperties(body, bodyPath, owner, objectType, parameters, context),
      };
    }
    case 'modifyObjectRule': {
      const object = yield* checkParameter(body['objectToModify'], `${bodyPath}.objectToModify`, owner, parameters);
      const objectType = yield* objectParameter(object, `${bodyPath}.objectToModify`, owner, parameters);

      yield* checkEditable(objectType, owner, context);

      return {
        kind: 'modifyObject',
        object,
        properties: yield* ruleProperties(body, bodyPath, owner, objectType, parameters, context),
      };
    }
    case 'deleteObjectRule': {
      const object = yield* checkParameter(body['objectToDelete'], `${bodyPath}.objectToDelete`, owner, parameters);

      yield* checkEditable(
        yield* objectParameter(object, `${bodyPath}.objectToDelete`, owner, parameters),
        owner,
        context,
      );

      return { kind: 'deleteObject', object };
    }
    case 'addLinkRule':
    case 'deleteLinkRule':
      return yield* linkRule(kind, body, bodyPath, owner, parameters, context);
  }

  const feature = own(OUTSIDE_RULES, kind);

  if (feature) return yield new CompileError(`${owner} has ${feature} (${kind}), which V1 does not have.`);

  return yield new CompileError(`${owner} has the rule ${kind}, which V1 does not have.`);
}

function* checkEditable(
  objectType: ObjectTypeApiName,
  owner: string,
  context: ActionTypeContext,
): Fallible<void, CompileError> {
  if (context.readOnly.has(objectType))
    return yield new CompileError(`${owner} edits ${objectType}, which turns off edits. ${EDITS_RULE}`);
}

function* linkRule(
  kind: 'addLinkRule' | 'deleteLinkRule',
  body: JsonRecord,
  path: string,
  owner: string,
  parameters: Parameters,
  context: ActionTypeContext,
): Fallible<Rule, CompileError> {
  const id = yield* string(body['linkTypeId'], `${path}.linkTypeId`);
  const apiName = camelCaseOf(id);
  const linkType = context.linkTypes.get(apiName);

  if (!linkType)
    return yield new CompileError(`${owner} has a link rule on the Link Type ${id}, which the Ontology does not have.`);

  if (linkType.storage.kind !== 'joinTable') {
    return yield new CompileError(
      `${owner} has a link rule on the one-to-many Link Type ${id}. A Create link or Delete link rule uses a many-to-many Link Type.`,
    );
  }

  const source = yield* checkParameter(body['sourceObject'], `${path}.sourceObject`, owner, parameters);
  const target = yield* checkParameter(body['targetObject'], `${path}.targetObject`, owner, parameters);
  const sourceType = yield* objectParameter(source, `${path}.sourceObject`, owner, parameters);
  const targetType = yield* objectParameter(target, `${path}.targetObject`, owner, parameters);

  const side = [...(context.objectTypes.get(sourceType)?.links.values() ?? [])].find(
    (link) => link.linkType === apiName && link.target === targetType,
  );

  if (!side)
    return yield new CompileError(
      `${owner} has a link rule on ${id} from ${sourceType} to ${targetType}, which the Link Type does not join.`,
    );

  return { kind: kind === 'addLinkRule' ? 'addLink' : 'deleteLink', link: side.apiName, source, target };
}

function* ruleProperties(
  body: JsonRecord,
  path: string,
  owner: string,
  objectTypeName: ObjectTypeApiName,
  parameters: Parameters,
  context: ActionTypeContext,
): Fallible<Map<PropertyApiName, RuleValue>, CompileError> {
  const objectType = context.objectTypes.get(objectTypeName);

  if (!objectType)
    return yield new CompileError(
      `${owner} has a rule on the Object Type ${objectTypeName}, which the Ontology does not have.`,
    );

  const properties = new Map<PropertyApiName, RuleValue>();

  const property = function* (name: string): Fallible<CompiledProperty, CompileError> {
    const found = yield* storedProperty(objectType, name, `written by ${owner}`);

    if (!found)
      return yield new CompileError(`${owner} maps the Property ${name}, which ${objectTypeName} does not have.`);

    return found;
  };

  for (const [name, value] of Object.entries(yield* record(body['propertyValues'], `${path}.propertyValues`))) {
    if ((yield* property(name)).type.kind === 'struct') {
      return yield new CompileError(
        `${owner} maps the struct Property ${name} in propertyValues. A struct Property gets its value only from 1 struct parameter, in structFieldValues.`,
      );
    }

    properties.set(name, yield* ruleValue(value, `${path}.propertyValues.${name}`, owner, parameters, context));
  }

  const structs =
    body['structFieldValues'] === undefined
      ? {}
      : yield* record(body['structFieldValues'], `${path}.structFieldValues`);

  for (const [name, value] of Object.entries(structs)) {
    const fieldsPath = `${path}.structFieldValues.${name}`;
    const fields = Object.entries(yield* record(value, fieldsPath));
    const structProperty = yield* property(name);

    if (structProperty.type.kind !== 'struct')
      return yield new CompileError(`${owner} maps struct fields to the Property ${name}, which is not a struct.`);

    const parameterId = yield* structSource(fields, fieldsPath, owner, name);

    yield* checkStructParameter(parameterId, name, structProperty.type.fields, owner, objectTypeName, parameters);

    const mapped = new Set(fields.map(([field]) => field));

    for (const field of structProperty.type.fields.keys()) {
      if (!mapped.has(field))
        return yield new CompileError(
          `${owner} does not map the field ${field} of the struct Property ${name}. The rule maps each field of the struct Property.`,
        );
    }

    for (const field of mapped) {
      if (!structProperty.type.fields.has(field))
        return yield new CompileError(
          `${owner} maps the field ${field}, which the struct Property ${name} does not have.`,
        );
    }

    properties.set(name, { kind: 'structParameter', parameter: parameterId });
  }

  return properties;
}

function* structSource(
  fields: readonly [string, unknown][],
  path: string,
  owner: string,
  propertyName: string,
): Fallible<ParameterId, CompileError> {
  let parameterId: ParameterId | undefined;

  for (const [field, fieldValue] of fields) {
    const fieldPath = `${path}.${field}`;

    if ((yield* tag(fieldValue, fieldPath)) !== 'structParameterFieldValue') {
      return yield new CompileError(
        `${owner} maps the field ${field} of the struct Property ${propertyName} to a value that is not a struct parameter field. A struct Property gets its value only from 1 struct parameter.`,
      );
    }

    const source = yield* record(
      (yield* record(fieldValue, fieldPath))['structParameterFieldValue'],
      `${fieldPath}.structParameterFieldValue`,
    );

    if (
      (yield* string(source['structFieldApiName'], `${fieldPath}.structParameterFieldValue.structFieldApiName`)) !==
      field
    ) {
      return yield new CompileError(
        `${owner} maps the field ${field} of the struct Property ${propertyName} to another field. The rule maps each field to the same field of the struct parameter.`,
      );
    }

    const fieldParameter = yield* string(source['parameterId'], `${fieldPath}.structParameterFieldValue.parameterId`);

    if (parameterId !== undefined && fieldParameter !== parameterId) {
      return yield new CompileError(
        `${owner} maps the field ${field} of the struct Property ${propertyName} from ${fieldParameter}, and another field from ${parameterId}. A struct Property gets its value only from 1 struct parameter.`,
      );
    }

    parameterId = fieldParameter;
  }

  if (parameterId === undefined)
    return yield new CompileError(`${owner} maps no field of the struct Property ${propertyName}.`);

  return parameterId;
}

function* checkStructParameter(
  parameterId: string,
  propertyName: string,
  propertyFields: ReadonlyMap<string, { kind: string }>,
  owner: string,
  objectType: ObjectTypeApiName,
  parameters: Parameters,
): Fallible<void, CompileError> {
  const parameter = parameters.get(parameterId);

  if (parameter?.type.kind !== 'struct')
    return yield new CompileError(
      `${owner} maps the struct Property ${propertyName} from ${parameterId}, which is not a struct parameter.`,
    );

  const differ = (detail: string) =>
    new CompileError(
      `The struct parameter ${parameterId} of ${owner} differs from the struct Property ${propertyName} of ${objectType}: ${detail}. A struct parameter has the same fields and base types as its struct Property.`,
    );

  for (const [field, type] of propertyFields) {
    const parameterField = parameter.type.fields.get(field);

    if (!parameterField) return yield differ(`it has no field ${field}`);

    if (parameterField.type.kind !== type.kind)
      return yield differ(
        `the field ${field} is ${parameterField.type.kind} in the parameter and ${type.kind} in the Property`,
      );
  }

  for (const field of parameter.type.fields.keys()) {
    if (!propertyFields.has(field)) return yield differ(`the Property has no field ${field}`);
  }
}

const OUTSIDE_VALUES: Readonly<Record<string, string>> = {
  interfaceParameterPropertyValue: 'an Interface parameter Property value',
  mediaReferenceParameterPropertyValue: 'a media reference value',
  synchronousWebhookOutput: 'a webhook output value',
  scheduleRunRid: 'a schedule run value',
};

function* ruleValue(
  value: unknown,
  path: string,
  owner: string,
  parameters: Parameters,
  context: ActionTypeContext,
): Fallible<RuleValue, CompileError> {
  const kind = yield* tag(value, path);
  const body = (yield* record(value, path))[kind];

  switch (kind) {
    case 'parameterId':
      return { kind: 'parameter', parameter: yield* checkParameter(body, `${path}.parameterId`, owner, parameters) };
    case 'staticValue':
      return { kind: 'static', value: yield* staticValue(body, `${path}.staticValue`, owner) };
    case 'objectParameterPropertyValue':
      return {
        kind: 'objectProperty',
        ...(yield* objectParameterProperty(body, `${path}.${kind}`, owner, parameters, context)),
      };
    case 'currentUser':
      return { kind: 'currentUser' };
    case 'currentTime':
      return { kind: 'currentTime' };
    case 'uniqueIdentifier':
      return { kind: 'uniqueIdentifier' };
  }

  const feature = own(OUTSIDE_VALUES, kind);

  if (feature) return yield new CompileError(`${owner} has ${feature} (${kind}), which V1 does not have.`);

  return yield new CompileError(`${owner} has the rule value ${kind}, which V1 does not have.`);
}
