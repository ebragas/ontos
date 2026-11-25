import { createHash } from 'node:crypto';
import { type Fallible } from '../errors/index.ts';
import { CompileError } from './compiled/stored.ts';

const ONTOLOGY_RID = /^ri\.ontology\.main\.ontology\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function* ridNamespace(ontologyRid: string): Fallible<string, CompileError> {
  const uuid = ONTOLOGY_RID.exec(ontologyRid)?.[1];

  if (!uuid)
    return yield new CompileError(
      `The Ontology RID ${ontologyRid} does not have the form ri.ontology.main.ontology.<UUID>.`,
    );

  return uuid.toLowerCase();
}

export function uuidV5(namespace: string, name: string): string {
  const bytes = createHash('sha1')
    .update(Buffer.from(namespace.replaceAll('-', ''), 'hex'))
    .update(name, 'utf8')
    .digest()
    .subarray(0, 16);

  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = bytes.toString('hex');

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function linkTypeRid(namespace: string, linkTypeId: string): string {
  return `ri.ontology.main.relation.${uuidV5(namespace, `relation:${linkTypeId}`)}`;
}

export function actionTypeRid(namespace: string, actionType: string): string {
  return `ri.actions.main.action-type.${uuidV5(namespace, `action-type:${actionType}`)}`;
}

export function structFieldRid(namespace: string, objectType: string, property: string, field: string): string {
  return `ri.ontology.main.struct-field.${uuidV5(namespace, `struct-field:${objectType}.${property}.${field}`)}`;
}
