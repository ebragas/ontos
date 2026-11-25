import { createHash } from 'node:crypto';

const MAX_NAME_BYTES = 63;

export function tableName(objectTypeApiName: string): string {
  const lastDot = objectTypeApiName.lastIndexOf('.');

  return snakeCase(objectTypeApiName.slice(lastDot + 1));
}

export function columnName(propertyApiName: string): string {
  return snakeCase(propertyApiName);
}

export function joinTableName(linkTypeApiName: string): string {
  return snakeCase(linkTypeApiName);
}

export function indexName(
  kind: 'pk' | 'trgm' | 'fk' | 'join' | 'policy' | 'unique',
  table: string,
  part?: string,
): string {
  const parts = part === undefined ? [kind, table] : [kind, table, part];
  const suffix = `_${createHash('sha1').update(parts.join(':')).digest('hex').slice(0, 8)}`;
  const bytes = new TextEncoder().encode(parts.join('_'));
  const head = new TextDecoder().decode(bytes.slice(0, MAX_NAME_BYTES - suffix.length)).replace(/�+$/, '');

  return `${head}${suffix}`;
}

export function snakeCase(apiName: string): string {
  const name = apiName
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();

  return truncateBytes(name, MAX_NAME_BYTES);
}

function truncateBytes(name: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(name);

  if (bytes.length <= maxBytes) return name;

  return new TextDecoder().decode(bytes.slice(0, maxBytes)).replace(/�+$/, '');
}
