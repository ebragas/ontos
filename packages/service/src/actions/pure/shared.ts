import { invariant } from '../../errors/index.ts';
import type {
  CompiledObjectType,
  CompiledOntology,
  CompiledProperty,
  ObjectTypeApiName,
  ParameterId,
  PropertyApiName,
} from '../../ontology/index.ts';
import type { ObjectLocator } from '../edit.ts';
import type { LoadedObject } from '../objects.ts';

export * from './guards.ts';

export function objectTypeOf(ontology: CompiledOntology, apiName: ObjectTypeApiName): CompiledObjectType {
  const objectType = ontology.objectTypes.get(apiName);

  invariant(objectType, `The compiled Ontology has no Object Type ${apiName}.`);

  return objectType;
}

export function propertyOf(objectType: CompiledObjectType, apiName: PropertyApiName): CompiledProperty {
  const property = objectType.properties.get(apiName);

  invariant(property, `The Object Type ${objectType.apiName} has no Property ${apiName}.`);

  return property;
}

export function objectOf(
  objects: ReadonlyMap<ParameterId, LoadedObject | readonly LoadedObject[]>,
  parameter: ParameterId,
): LoadedObject | undefined {
  const object = objects.get(parameter);

  invariant(!Array.isArray(object), `The Action uses the Object list parameter ${parameter} as 1 Object.`);

  return object as LoadedObject | undefined;
}

export function objectKey(object: ObjectLocator): string {
  return JSON.stringify([object.objectType, object.primaryKey]);
}
