import type { ListOntologiesV2Response, OntologyV2 } from '@osdk/foundry.ontologies';
import type { OrganizationData, OrganizationId } from '../../auth/index.ts';
import type { Db, DbFailure } from '../../db/index.ts';
import type { AsyncFallible } from '../../errors/index.ts';
import type { OrganizationCtx, RouteInput } from '../../handler/index.ts';

export const REGISTRY_SCHEMA = 'ontology_registry';

export interface RegistryRow {
  readonly rid: string;
  readonly api_name: string;
  readonly display_name: string;
}

export function ontologyEntry(row: RegistryRow): OntologyV2 {
  return { rid: row.rid, apiName: row.api_name, displayName: row.display_name, description: '' };
}

export async function* listOntologies(
  input: RouteInput,
  ctx: OrganizationCtx<OrganizationData>,
): AsyncFallible<Response, DbFailure> {
  void input;

  const data = yield* listOntologyEntries(ctx.db, ctx.caller.organization);

  return Response.json({ data } satisfies ListOntologiesV2Response);
}

export async function* listOntologyEntries(
  db: Db,
  organization: OrganizationId,
): AsyncFallible<OntologyV2[], DbFailure> {
  const rows = yield* db.query<RegistryRow>({
    text: `SELECT rid, api_name, display_name FROM ${REGISTRY_SCHEMA}.ontologies WHERE organization = $1 ORDER BY api_name COLLATE "C"`,
    values: [organization],
  });

  return rows.map(ontologyEntry);
}
