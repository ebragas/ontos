import { REGISTRY_SCHEMA } from './db/index.ts';
import { transact, type Db } from './db/promise.test-utils.ts';
import { installFrom, type Installation, type InstallInput } from './publish/install.ts';
import { ORGANIZATION } from './tokens.test-utils.ts';

export function installOntology(db: Db, input: InstallInput): Promise<Installation> {
  return transact(db, (tx) => installFrom(tx, input));
}

export async function isInstalled(db: Db, rid: string): Promise<boolean> {
  const rows = await db.query({ text: `SELECT 1 FROM ${REGISTRY_SCHEMA}.ontologies WHERE rid = $1`, values: [rid] });

  return rows.length > 0;
}

export async function installOnce(
  db: Db,
  rid: string,
  product: string,
  organization: string = ORGANIZATION,
): Promise<void> {
  if (await isInstalled(db, rid)) return;

  await installOntology(db, { rid, product, apiName: product, displayName: product, organization });
}
