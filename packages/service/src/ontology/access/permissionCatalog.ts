import type { CompiledOntology } from '../compiled/objects.ts';
import {
  parseGrantsFile,
  SERVICE_PERMISSION_DESCRIPTIONS,
  SERVICE_PERMISSIONS,
  type GrantsFile,
  type PermissionSlug,
} from '../grantsFile.ts';
import { permissionIndex, type PermissionIndex } from './permissionIndex.ts';

export interface CatalogEntry {
  readonly slug: PermissionSlug;
  readonly description: string;
  readonly requires: readonly PermissionSlug[];
}

export function permissionCatalog(grants: GrantsFile, index: PermissionIndex): readonly CatalogEntry[] {
  const requires = new Map<PermissionSlug, Set<PermissionSlug>>();

  for (const action of index.actionTypes.values()) {
    const joined = requires.get(action.own) ?? new Set();

    for (const slug of action.requires) joined.add(slug);

    requires.set(action.own, joined);
  }

  const entries: CatalogEntry[] = SERVICE_PERMISSIONS.map((slug) => ({
    slug,
    description: SERVICE_PERMISSION_DESCRIPTIONS[slug] ?? '',
    requires: [],
  }));

  for (const [slug, { description }] of Object.entries(grants.permissions)) {
    if (SERVICE_PERMISSIONS.includes(slug)) continue;

    entries.push({ slug, description, requires: [...(requires.get(slug) ?? [])].sort(byCodePoint) });
  }

  return entries.sort((left, right) => byCodePoint(left.slug, right.slug));
}

export function loadPermissionCatalog(ontology: CompiledOntology, stored: unknown): readonly CatalogEntry[] {
  const parsed = parseGrantsFile(stored);

  return 'grants' in parsed ? permissionCatalog(parsed.grants, permissionIndex(ontology, parsed.grants)) : [];
}

function byCodePoint(left: string, right: string): number {
  const a = Array.from(left);
  const b = Array.from(right);

  for (let at = 0; at < Math.min(a.length, b.length); at += 1) {
    const difference = (a[at]?.codePointAt(0) ?? 0) - (b[at]?.codePointAt(0) ?? 0);

    if (difference !== 0) return difference;
  }

  return a.length - b.length;
}
