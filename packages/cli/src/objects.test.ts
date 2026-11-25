import { describe, expect, it } from 'vitest';
import { CLIENT_2_PAGE_TOKEN, cli, stubExchange, replay, STUB, stubConfig, stubFetch } from './cli.test-utils.ts';

const ACCOUNT = 'com.example.twin.Account';
const flags = ['--app', 'twin', '--url', STUB];

const ACME = {
  phase: 'customer',
  accountId: 'acc-1',
  name: 'Acme',
  $apiName: ACCOUNT,
  $objectType: ACCOUNT,
  $primaryKey: 'acc-1',
  $title: 'Acme',
  $objectSpecifier: `${ACCOUNT}:acc-1`,
};

const GLOBEX = {
  phase: 'prospect',
  accountId: 'acc-2',
  name: 'Globex',
  $apiName: ACCOUNT,
  $objectType: ACCOUNT,
  $primaryKey: 'acc-2',
  $title: 'Globex',
  $objectSpecifier: `${ACCOUNT}:acc-2`,
};

describe('ontology objects', () => {
  it('service/cli#commands, service/cli#package: objects loads a page of Objects with the stock client, which knows the Object Type only by its API name and loads its metadata first', async () => {
    const page2 = stubExchange('client', 2);
    const fetch = stubFetch(stubConfig, replay(stubExchange('client', 1), page2));

    const run = await cli(['objects', ACCOUNT, '--page-size', '2', '--order-by', '{"name":"asc"}', ...flags], {
      fetch,
      env: { ONTOLOGY_TOKEN: 't' },
    });

    expect(run.error).toBeUndefined();
    expect(run.code).toBe(0);
    expect(run.output).toEqual({ data: [ACME, GLOBEX], nextPageToken: CLIENT_2_PAGE_TOKEN, totalCount: '3' });

    expect(fetch.calls.map(({ method, url }) => `${method} ${new URL(url).pathname}`)).toEqual([
      'GET /api/ontology-service/v1/client-config',
      'GET /api/v2/ontologies',
      `GET /api/v2/ontologies/${'ri.ontology.main.ontology.22144f95-115e-4429-8bda-c69ce9a98a01'}/objectTypes/${ACCOUNT}/fullMetadata`,
      `POST /api/v2/ontologies/ri.ontology.main.ontology.22144f95-115e-4429-8bda-c69ce9a98a01/objectSets/loadObjects`,
    ]);
  });
});
