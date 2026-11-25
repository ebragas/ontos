import { uuidV5 } from '../rids.ts';

export function objectTypeRid(namespace: string, objectType: string): string {
  return `ri.ontology.main.object-type.${uuidV5(namespace, `object-type:${objectType}`)}`;
}

export function propertyRid(namespace: string, objectType: string, property: string): string {
  return `ri.ontology.main.property.${uuidV5(namespace, `property:${objectType}.${property}`)}`;
}

export function functionRid(namespace: string, functionApiName: string): string {
  return `ri.function-registry.main.function.${uuidV5(namespace, `function:${functionApiName}`)}`;
}

export function valueTypeRid(namespace: string, valueType: string): string {
  return `ri.type-registry.main.value-type.${uuidV5(namespace, `value-type:${valueType}`)}`;
}
