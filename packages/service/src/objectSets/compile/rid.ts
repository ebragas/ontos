import { createHash } from 'node:crypto';
import { invariant } from '../../errors/index.ts';

const ONTOLOGY_RID = /^ri\.ontology\.main\.ontology\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function objectRids(ontologyRid: string, objectType: string): (primaryKey: string) => string {
  const uuid = ONTOLOGY_RID.exec(ontologyRid)?.[1];

  invariant(uuid, `The Ontology RID ${ontologyRid} does not have the form ri.ontology.main.ontology.<UUID>.`);

  const namespace = Buffer.from(uuid.replaceAll('-', ''), 'hex');

  return (primaryKey) =>
    `ri.phonograph2-objects.main.object.${uuidV5(namespace, `object:${objectType}:${primaryKey}`)}`;
}

function uuidV5(namespace: Buffer, name: string): string {
  const bytes = createHash('sha1').update(namespace).update(name, 'utf8').digest().subarray(0, 16);

  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = bytes.toString('hex');

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
