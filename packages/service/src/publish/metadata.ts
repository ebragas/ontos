import { invariant } from '../errors/index.ts';
import type {
  ActionParameterType,
  ActionParameterV2,
  ActionParameterValidation,
  ActionTypeV2,
  LinkTypeSideV2,
  LogicRule,
  ObjectPropertyType,
  ObjectTypeDatasource,
  ObjectTypeFullMetadata,
  OntologyDataType,
  OntologyFullMetadata,
  OntologyValueType,
  PropertyTypeStatus,
  PropertyV2,
  QueryDataType,
  QueryTypeV2,
  ValueTypeConstraint,
  ValueTypeFieldType,
} from '@osdk/foundry.ontologies';
import {
  QUERY_TYPE_VERSION,
  structFieldRid,
  type AllowedValues,
  type CompiledActionType,
  type CompiledDerivedProperty,
  type CompiledObjectType,
  type CompiledOntology,
  type CompiledParameter,
  type CompiledProperty,
  type CompiledValueType,
  type OutputValueType,
  type ParameterScalarType,
  type ParameterType,
  type StructParameterType,
  type PropertyStatus,
  type QueryFunction,
  type Rule,
  type ScalarType,
  type Status,
  type ValueTypeRule,
} from '../ontology/index.ts';

export function toFullMetadata(ontology: CompiledOntology): OntologyFullMetadata {
  const namespace = (ontology.metadata.ontology.rid.split('.').at(-1) ?? '').toLowerCase();
  const objectTypes: Record<string, ObjectTypeFullMetadata> = {};

  for (const objectType of ontology.objectTypes.values())
    objectTypes[objectType.apiName] = objectTypeMetadata(objectType, ontology, namespace);

  const actionTypes: Record<string, ActionTypeV2> = {};

  for (const actionType of ontology.actionTypes.values())
    actionTypes[actionType.apiName] = actionTypeMetadata(actionType, ontology);

  const queryTypes: Record<string, QueryTypeV2> = {};

  for (const fn of ontology.functions.values()) if (fn.kind === 'query') queryTypes[fn.apiName] = queryTypeMetadata(fn);

  return {
    ontology: { apiName: 'ontology', displayName: 'Ontology', description: '', rid: ontology.metadata.ontology.rid },
    objectTypes,
    actionTypes,
    actionTypesFullMetadata: {},
    queryTypes,
    interfaceTypes: {},
    sharedPropertyTypes: {},
    valueTypes: valueTypesMetadata(ontology),
  };
}

function objectTypeMetadata(
  objectType: CompiledObjectType,
  ontology: CompiledOntology,
  namespace: string,
): ObjectTypeFullMetadata {
  const { display } = objectType;
  const properties: Record<string, PropertyV2> = {};

  for (const property of objectType.properties.values())
    properties[property.apiName] = propertyMetadata(property, objectType, namespace);

  for (const property of objectType.derived.values())
    properties[property.apiName] = propertyMetadata(property, objectType, namespace);

  const linkTypes: LinkTypeSideV2[] = [];

  for (const link of objectType.links.values()) {
    const linkType = ontology.linkTypes.get(link.linkType);

    invariant(
      linkType,
      `The Link side ${link.apiName} on ${objectType.apiName} names the Link Type ${link.linkType}, which the Ontology does not have.`,
    );

    const foreignKey =
      link.via.kind === 'foreignKeyHere' && linkType.storage.kind === 'foreignKey'
        ? linkType.storage.property.apiName
        : undefined;

    linkTypes.push({
      apiName: link.apiName,
      displayName: link.displayName,
      status: releaseStatus(linkType.status),
      objectTypeApiName: link.target,
      cardinality: link.cardinality,
      ...(foreignKey === undefined ? {} : { foreignKeyPropertyApiName: foreignKey }),
      linkTypeRid: linkType.rid,
    });
  }

  return {
    objectType: {
      apiName: objectType.apiName,
      displayName: display.displayName,
      status: releaseStatus(objectType.status),
      ...described(display.description),
      pluralDisplayName: display.pluralDisplayName,
      icon: { type: 'blueprint', color: display.icon.color, name: display.icon.locator },
      primaryKey: objectType.primaryKey.apiName,
      properties,
      rid: objectType.rid,
      titleProperty: objectType.titleKey,
      visibility: display.visibility,
      aliases: [],
      datasources: derivedDatasources(objectType),
    },
    linkTypes,
    implementsInterfaces: [],
    implementsInterfaces2: {},
    sharedPropertyTypeMapping: {},
  };
}

function derivedDatasources(objectType: CompiledObjectType): ObjectTypeDatasource[] {
  if (objectType.derived.size === 0) return [];

  const rid = objectType.rid.replace('.object-type.', '.datasource.');

  return [
    {
      rid,
      definition: { type: 'unsupported', unsupportedType: 'derived', properties: [...objectType.derived.keys()] },
    },
  ];
}

function propertyMetadata(
  property: CompiledProperty | CompiledDerivedProperty,
  objectType: CompiledObjectType,
  namespace: string,
): PropertyV2 {
  const { display } = property;

  return {
    displayName: display.displayName,
    ...described(display.description),
    dataType: dataType(property, objectType, namespace),
    rid: property.rid,
    status: propertyStatus(property.status, objectType),
    visibility: display.visibility,
    typeClasses: [...display.typeClasses],
    ...('valueType' in property && property.valueType ? { valueTypeApiName: property.valueType.apiName } : {}),
    ...('required' in property && property.required && property.apiName !== objectType.primaryKey.apiName
      ? { dataConstraints: { nullability: 'NOT_NULLABLE' } }
      : {}),
  };
}

function dataType(
  property: CompiledProperty | CompiledDerivedProperty,
  objectType: CompiledObjectType,
  namespace: string,
): ObjectPropertyType {
  const { type } = property;

  switch (type.kind) {
    case 'array':
      return { type: 'array', subType: scalarType(type.element), reducers: [] };
    case 'struct':
      return {
        type: 'struct',
        structFieldTypes: [...type.fields].map(([apiName, field]) => ({
          apiName,
          rid: structFieldRid(namespace, objectType.apiName, property.apiName, apiName),
          dataType: scalarType(field),
          typeClasses: [...(property.display.structFields.get(apiName) ?? [])],
        })),
      };
    default:
      return scalarType(type);
  }
}

function scalarType(type: ScalarType): ObjectPropertyType {
  return type.kind === 'decimal'
    ? { type: 'decimal', precision: type.precision, scale: type.scale }
    : { type: type.kind };
}

function valueTypesMetadata(ontology: CompiledOntology): Record<string, OntologyValueType> {
  const used = new Map<string, CompiledValueType>();

  for (const objectType of ontology.objectTypes.values()) {
    for (const { valueType } of objectType.properties.values()) if (valueType) used.set(valueType.apiName, valueType);
  }

  return Object.fromEntries([...used].map(([apiName, valueType]) => [apiName, ontologyValueType(valueType)]));
}

function ontologyValueType(valueType: CompiledValueType): OntologyValueType {
  const { baseType } = valueType;

  return {
    apiName: valueType.apiName,
    displayName: valueType.displayName,
    ...described(valueType.description),
    rid: valueType.rid,
    status: valueType.status === 'active' ? 'ACTIVE' : 'DEPRECATED',
    fieldType:
      baseType.kind === 'array' ? { type: 'array', subType: fieldType(baseType.element) } : fieldType(baseType.kind),
    version: valueType.version,
    constraints: valueType.constraints.map(({ rule }) => wireConstraint(rule)),
  };
}

function fieldType(kind: ScalarType['kind']): ValueTypeFieldType {
  return { type: kind };
}

function wireConstraint(rule: ValueTypeRule): ValueTypeConstraint {
  switch (rule.kind) {
    case 'enum':
      return { type: 'enum', options: [...rule.options] };
    case 'range':
      return {
        type: 'range',
        ...(rule.minimum === undefined ? {} : { minimumValue: rule.minimum }),
        ...(rule.maximum === undefined ? {} : { maximumValue: rule.maximum }),
      };
    case 'length':
      return {
        type: 'length',
        ...(rule.minimum === undefined ? {} : { minimumLength: rule.minimum }),
        ...(rule.maximum === undefined ? {} : { maximumLength: rule.maximum }),
      };
    case 'regex':
      return { type: 'regex', pattern: rule.pattern, partialMatch: rule.partialMatch };
    case 'uuid':
      return { type: 'uuid' };
    case 'array':
      return {
        type: 'array',
        ...(rule.minimumSize === undefined ? {} : { minimumSize: rule.minimumSize }),
        ...(rule.maximumSize === undefined ? {} : { maximumSize: rule.maximumSize }),
        uniqueValues: rule.uniqueValues,
        ...(rule.element === undefined ? {} : { valueConstraint: wireConstraint(rule.element) }),
      };
  }
}

function actionTypeMetadata(actionType: CompiledActionType, ontology: CompiledOntology): ActionTypeV2 {
  const { display } = actionType;

  const inputDescriptions =
    actionType.logic.kind === 'function' ? ontology.functions.get(actionType.logic.function)?.descriptions : undefined;

  const parameters: Record<string, ActionParameterV2> = Object.fromEntries(
    [...actionType.parameters.values()].map((parameter) => {
      const values = display.parameters.get(parameter.id);

      const metadataOfParameter: ActionParameterV2 = {
        displayName: values?.displayName ?? parameter.id.charAt(0).toUpperCase() + parameter.id.slice(1),
        ...described(values?.description ?? inputDescriptions?.get(parameter.id)),
        dataType: parameterType(parameter.type),
        required: parameter.required,
        typeClasses: [...(values?.typeClasses ?? [])],
        ...validation(parameter.allowed),
      };

      return [parameter.id, metadataOfParameter];
    }),
  );

  return {
    apiName: actionType.apiName,
    displayName: display.displayName,
    ...described(display.description),
    status: releaseStatus(actionType.status),
    parameters,
    rid: actionType.rid,
    operations:
      actionType.logic.kind === 'rules'
        ? actionType.logic.rules.map((rule) => operation(rule, actionType.parameters, ontology))
        : [],
  };
}

function validation(allowed: AllowedValues): { validation?: ActionParameterValidation } {
  if (allowed.kind !== 'oneOf') return {};

  const options = allowed.values.map((value) => ({ displayName: '', value }));

  return {
    validation: {
      defaultValidation: { allowedValues: { type: 'oneOf', options, otherValuesAllowed: allowed.otherValueAllowed } },
    },
  };
}

function parameterType(type: ParameterType): ActionParameterType {
  switch (type.kind) {
    case 'list':
      return {
        type: 'array',
        subType: type.element.kind === 'struct' ? structType(type.element) : parameterScalarType(type.element),
      };
    case 'struct':
      return structType(type);
    case 'object':
      return { type: 'object', objectApiName: type.objectType, objectTypeApiName: type.objectType };
    case 'objectList':
      return {
        type: 'array',
        subType: { type: 'object', objectApiName: type.objectType, objectTypeApiName: type.objectType },
      };
    default:
      return parameterScalarType(type);
  }
}

function structType(type: StructParameterType): ActionParameterType {
  return {
    type: 'struct',
    fields: [...type.fields].map(([name, field]) => ({
      name,
      fieldType: parameterScalarType(field.type),
      required: field.required,
    })),
  };
}

function parameterScalarType(type: ParameterScalarType): ActionParameterType & OntologyDataType {
  if (type.kind !== 'decimal') return { type: type.kind };

  return {
    type: 'decimal',
    ...(type.precision === undefined ? {} : { precision: type.precision }),
    ...(type.scale === undefined ? {} : { scale: type.scale }),
  };
}

function objectTypeOf(parameters: ReadonlyMap<string, CompiledParameter>, id: string): string {
  const type = parameters.get(id)?.type;

  invariant(type?.kind === 'object', `The parameter ${id} is not an Object parameter.`);

  return type.objectType;
}

function operation(
  rule: Rule,
  parameters: ReadonlyMap<string, CompiledParameter>,
  ontology: CompiledOntology,
): LogicRule {
  switch (rule.kind) {
    case 'addObject':
      return { type: 'createObject', objectTypeApiName: rule.objectType };
    case 'modifyObject':
    case 'deleteObject':
      return { type: rule.kind, objectTypeApiName: objectTypeOf(parameters, rule.object) };
    case 'addLink':
    case 'deleteLink': {
      const a = objectTypeOf(parameters, rule.source);
      const b = objectTypeOf(parameters, rule.target);
      const link = ontology.objectTypes.get(a)?.links.get(rule.link);

      const reverse = [...(ontology.objectTypes.get(b)?.links.values() ?? [])].find(
        (other) => other.linkType === link?.linkType && (a !== b || other.apiName !== rule.link),
      );

      return {
        type: rule.kind === 'addLink' ? 'createLink' : 'deleteLink',
        linkTypeApiNameAtoB: rule.link,
        linkTypeApiNameBtoA: reverse?.apiName ?? rule.link,
        aSideObjectTypeApiName: a,
        bSideObjectTypeApiName: b,
      };
    }
  }
}

function queryTypeMetadata(fn: QueryFunction): QueryTypeV2 {
  const parameters = Object.fromEntries(
    [...fn.parameters.values()].map(({ id, type, required }) => [
      id,
      { ...described(fn.descriptions.get(id)), dataType: orNull(queryDataType(type), !required), required },
    ]),
  );

  return {
    apiName: fn.apiName,
    ...described(fn.description),
    parameters,
    output: orNull(queryDataType(fn.output.type), fn.output.optional),
    rid: fn.rid,
    version: QUERY_TYPE_VERSION,
    typeReferences: {},
  };
}

function queryDataType(type: ParameterType | OutputValueType): QueryDataType {
  switch (type.kind) {
    case 'decimal':
      return { type: 'string' };
    case 'object':
      return { type: 'object', objectApiName: type.objectType, objectTypeApiName: type.objectType };
    case 'objectList':
      return { type: 'array', subType: queryDataType({ kind: 'object', objectType: type.objectType }) };
    case 'list':
      return { type: 'array', subType: queryDataType(type.element) };
    case 'struct':
      return {
        type: 'struct',
        fields: [...type.fields].map(([name, field]) => ({
          name,
          fieldType: orNull(queryDataType(field.type), 'optional' in field ? field.optional : !field.required),
        })),
      };
    default:
      return { type: type.kind };
  }
}

function orNull(type: QueryDataType, nullable: boolean): QueryDataType {
  return nullable ? { type: 'union', unionTypes: [type, { type: 'null' }] } : type;
}

function releaseStatus(status: Status): 'ACTIVE' | 'DEPRECATED' | 'EXPERIMENTAL' {
  return status === 'active' ? 'ACTIVE' : status === 'deprecated' ? 'DEPRECATED' : 'EXPERIMENTAL';
}

function propertyStatus(status: PropertyStatus, objectType: CompiledObjectType): PropertyTypeStatus {
  if (status.type === 'deprecated') {
    const { message, deadline, replacedBy } = status;
    const replacement = replacedBy ? objectType.properties.get(replacedBy)?.rid : undefined;

    return { type: 'deprecated', message, deadline, ...(replacement ? { replacedBy: replacement } : {}) };
  }

  return status.type === 'active' ? { type: 'active' } : { type: 'experimental' };
}

function described(description: string | null | undefined): { description?: string } {
  return description ? { description } : {};
}
