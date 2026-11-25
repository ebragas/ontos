import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { linkTypeRid, ridNamespace } from '@ericbragas/ontos-service/convert';
import { orThrow } from '../fallible.ts';
import { describe, expect, it } from 'vitest';
import { findLinkType } from './linkType.ts';

const require = createRequire(import.meta.url);
const makerEntry = require.resolve('@osdk/maker');
const maker = require('@osdk/maker') as typeof import('@osdk/maker');

const NAMES = [
  'companyToSubsidiaries',
  'projectToTasks',
  'q3ReportToOwners',
  'legacy_link_name',
  'APIKeyToUsers',
  'apiNAMEToItems',
];

async function makerIds(): Promise<(string | undefined)[]> {
  const ir = await maker.defineOntology(
    'com.acme.',
    async () => {
      const owner = maker.defineObject({
        apiName: 'Owner',
        displayName: 'Owner',
        pluralDisplayName: 'Owners',
        titlePropertyApiName: 'ownerId',
        primaryKeyPropertyApiName: 'ownerId',
        properties: { ownerId: { type: 'string' } },
      });

      const item = maker.defineObject({
        apiName: 'Item',
        displayName: 'Item',
        pluralDisplayName: 'Items',
        titlePropertyApiName: 'itemId',
        primaryKeyPropertyApiName: 'itemId',
        properties: {
          itemId: { type: 'string' },
          ...Object.fromEntries(NAMES.map((_, index) => [`owner${index}`, { type: 'string' as const }])),
        },
      });

      NAMES.forEach((apiName, index) =>
        maker.defineLink({
          apiName,
          one: {
            object: owner,
            metadata: {
              apiName: `items${index}`,
              displayName: 'Item',
              pluralDisplayName: 'Items',
              visibility: 'NORMAL',
            },
          },
          toMany: {
            object: item,
            metadata: {
              apiName: `owner${index}Link`,
              displayName: 'Owner',
              pluralDisplayName: 'Owners',
              visibility: 'NORMAL',
            },
          },
          manyForeignKeyProperty: `owner${index}`,
        }),
      );
    },
    undefined,
  );

  const ids = new Map(
    Object.values(ir.ontology.linkTypes).map(({ linkType: { id, definition } }) => [
      definition.type === 'oneToMany' ? definition.oneToMany.oneToManyLinkMetadata.apiName : undefined,
      id,
    ]),
  );

  return NAMES.map((_, index) => ids.get(`items${index}`));
}

describe('the Link Type ID of describe', () => {
  it('the CLI makes the same Link Type ID from a Link Type API name as @osdk/maker 0.91.0 writes, with no API namespace in it', async () => {
    const makerPackage = JSON.parse(
      readFileSync(join(makerEntry.slice(0, makerEntry.lastIndexOf('/build/')), 'package.json'), 'utf8'),
    ) as { version: string };

    expect(makerPackage.version).toBe('0.91.0');

    const ids = await makerIds();

    expect(ids).toEqual([
      'company-to-subsidiaries',
      'project-to-tasks',
      'q3-report-to-owners',
      'legacy-link-name',
      'api-key-to-users',
      'api-name-to-items',
    ]);

    const ontologyRid = 'ri.ontology.main.ontology.6f1c2a3b-4d5e-4f60-8a71-92b3c4d5e6f7';
    const namespace = orThrow(ridNamespace(ontologyRid));

    const pairs = NAMES.map((apiName, index) => {
      const id = ids[index];

      if (id === undefined) throw new Error(`@osdk/maker wrote no Link Type ID for ${apiName}.`);

      return { apiName, id };
    });

    expect(
      pairs.map(({ apiName, id }) => {
        const side = { linkTypeRid: linkTypeRid(namespace, id) };
        const other = { linkTypeRid: linkTypeRid(namespace, 'not-this-link') };

        return findLinkType(ontologyRid, apiName, [other, side]);
      }),
    ).toEqual(
      pairs.map(({ apiName, id }) => {
        const rid = linkTypeRid(namespace, id);

        return { apiName, rid, sides: [{ linkTypeRid: rid }] };
      }),
    );
  });
});
