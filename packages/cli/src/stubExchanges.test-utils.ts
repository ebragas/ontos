import { ontologyMetadata } from '@ericbragas/ontos-service/convert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Exchange } from './cli.test-utils.ts';
import { orThrow } from './fallible.ts';

const ROOT = new URL('../../../', import.meta.url).pathname;

export const STUB_ONTOLOGY_RID = 'ri.ontology.main.ontology.22144f95-115e-4429-8bda-c69ce9a98a01';
export const STUB_PAGE_TOKEN = 'stub-page-2-token';

const ACCOUNT = 'com.example.twin.Account';
const ENGAGEMENT = 'com.example.twin.Engagement';
const CREATE_ACCOUNT = 'com.example.twin.create-account';
const CREATE_ENGAGEMENT = 'com.example.twin.create-engagement';
const SET_ENGAGEMENT_STATUS = 'com.example.twin.set-engagement-status';

const OSDK_SET = (() => {
  const sets = JSON.parse(readFileSync(join(ROOT, 'packages/service/osdk-sets.json'), 'utf8')) as {
    name: string;
    packages: Record<string, string>;
  }[];

  const set = sets.find(({ name }) => name === 'client-2.92.0');

  if (!set) throw new Error('packages/service/osdk-sets.json has no OSDK set client-2.92.0.');

  return set.packages;
})();

let cachedMetadata: Record<string, unknown> | undefined;

export function stubMetadata(): Record<string, unknown> {
  if (!cachedMetadata) {
    const ir = JSON.parse(readFileSync(join(ROOT, 'packages/service/twin/ir/0.7.0.json'), 'utf8'));

    const { discovered } = JSON.parse(
      readFileSync(join(ROOT, 'packages/service/twin/functions/0.6.3.json'), 'utf8'),
    ) as { discovered: unknown[] };

    const bundle = readFileSync(join(ROOT, 'packages/service/twin/functions/0.6.3.bundle.js'), 'utf8');

    cachedMetadata = JSON.parse(
      JSON.stringify(
        orThrow(ontologyMetadata({ ir, osdkSet: OSDK_SET, functions: { discovered, bundle } }, STUB_ONTOLOGY_RID)),
      ),
    ) as Record<string, unknown>;
  }

  return structuredClone(cachedMetadata);
}

const base = `/api/v2/ontologies/${STUB_ONTOLOGY_RID}`;

function accountRow(accountId: string, name: string, phase: string) {
  return { __apiName: ACCOUNT, __primaryKey: accountId, __title: name, accountId, name, phase };
}

function engagementRow(
  engagementId: string,
  accountId: string,
  title: string,
  amount: number,
  status: string,
  createdAt = '2026-11-03T22:46:35.465Z',
) {
  return {
    __apiName: ENGAGEMENT,
    __primaryKey: engagementId,
    __title: title,
    engagementId,
    accountId,
    title,
    amount,
    status,
    createdAt,
  };
}

export function stubExchange(suite: 'client' | 'probe', id: number): Exchange {
  const meta = stubMetadata() as {
    objectTypes: Record<string, unknown>;
    actionTypes: Record<string, unknown>;
  };

  if (suite === 'probe') {
    const invalidValidation = {
      validation: {
        result: 'INVALID',
        submissionCriteria: [],
        parameters: {
          phase: { result: 'VALID', evaluatedConstraints: [], required: false },
          accountId: { result: 'VALID', evaluatedConstraints: [], required: false },
          name: { result: 'INVALID', evaluatedConstraints: [], required: true },
          note: { result: 'VALID', evaluatedConstraints: [], required: false },
          active: { result: 'VALID', evaluatedConstraints: [], required: false },
        },
      },
    };

    if (id === 22) {
      return {
        method: 'POST',
        path: `${base}/actions/${CREATE_ACCOUNT}/apply`,
        requestBody: {
          parameters: { accountId: 'p-noname' },
          options: { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'NONE' },
        },
        status: 200,
        responseBody: invalidValidation,
      };
    }

    if (id === 27) {
      return {
        method: 'POST',
        path: `${base}/actions/${CREATE_ACCOUNT}/apply`,
        requestBody: {
          parameters: { accountId: 'p-noname-v' },
          options: { mode: 'VALIDATE_ONLY', returnEdits: 'NONE' },
        },
        status: 200,
        responseBody: invalidValidation,
      };
    }

    throw new Error(`No synthetic probe exchange ${id}.`);
  }

  switch (id) {
    case 1:
      return {
        method: 'GET',
        path: `${base}/objectTypes/${ACCOUNT}/fullMetadata`,
        query: '?preview=true',
        requestBody: null,
        status: 200,
        responseBody: meta.objectTypes[ACCOUNT],
      };
    case 2:
      return {
        method: 'POST',
        path: `${base}/objectSets/loadObjects`,
        requestBody: {
          objectSet: { type: 'base', objectType: ACCOUNT },
          orderBy: { fields: [{ field: 'name', direction: 'asc' }] },
          select: [],
          selectV2: [],
          loadPropertySecurities: false,
          excludeRid: true,
          snapshot: false,
          pageSize: 2,
        },
        status: 200,
        responseBody: {
          data: [accountRow('acc-1', 'Acme', 'customer'), accountRow('acc-2', 'Globex', 'prospect')],
          nextPageToken: STUB_PAGE_TOKEN,
          totalCount: '3',
        },
      };
    case 3:
      return {
        method: 'POST',
        path: `${base}/objectSets/loadObjects`,
        requestBody: {
          objectSet: { type: 'base', objectType: ACCOUNT },
          orderBy: { fields: [{ field: 'name', direction: 'asc' }] },
          select: [],
          selectV2: [],
          loadPropertySecurities: false,
          excludeRid: true,
          snapshot: false,
          pageSize: 2,
          pageToken: STUB_PAGE_TOKEN,
        },
        status: 200,
        responseBody: {
          data: [accountRow('acc-3', 'Initech', 'customer')],
          totalCount: '3',
        },
      };
    case 4:
      return {
        method: 'GET',
        path: `${base}/objectTypes/${ENGAGEMENT}/fullMetadata`,
        query: '?preview=true',
        requestBody: null,
        status: 200,
        responseBody: meta.objectTypes[ENGAGEMENT],
      };
    case 5:
      return {
        method: 'POST',
        path: `${base}/objectSets/loadObjects`,
        requestBody: {
          objectSet: {
            type: 'filter',
            objectSet: { type: 'base', objectType: ENGAGEMENT },
            where: {
              type: 'and',
              value: [
                { type: 'gte', field: 'amount', value: 10000 },
                { type: 'not', value: { type: 'eq', field: 'status', value: 'lost' } },
              ],
            },
          },
          orderBy: { fields: [{ field: 'amount', direction: 'desc' }] },
          select: [],
          selectV2: [],
          loadPropertySecurities: false,
          excludeRid: true,
          snapshot: false,
        },
        status: 200,
        responseBody: {
          data: [
            engagementRow('eng-2', 'acc-1', 'Platform build', 48000, 'open'),
            engagementRow('eng-6', 'acc-2', 'Annual renewal', 24000, 'open'),
            engagementRow('eng-1', 'acc-1', 'Discovery workshop', 12000, 'won'),
          ],
          totalCount: '3',
        },
      };
    case 6:
      return {
        method: 'POST',
        path: `${base}/objectSets/loadObjects`,
        requestBody: {
          objectSet: {
            type: 'filter',
            objectSet: { type: 'base', objectType: ACCOUNT },
            where: { type: 'eq', field: 'accountId', value: 'acc-1' },
          },
          select: [],
          selectV2: [],
          loadPropertySecurities: false,
          excludeRid: true,
          pageSize: 1,
          snapshot: false,
        },
        status: 200,
        responseBody: {
          data: [accountRow('acc-1', 'Acme', 'customer')],
          totalCount: '1',
        },
      };
    case 8:
      return {
        method: 'POST',
        path: `${base}/objectSets/loadObjects`,
        requestBody: {
          objectSet: {
            type: 'searchAround',
            objectSet: {
              type: 'filter',
              objectSet: { type: 'base', objectType: ACCOUNT },
              where: { type: 'eq', field: 'accountId', value: 'acc-1' },
            },
            link: 'engagements',
          },
          select: [],
          selectV2: [],
          loadPropertySecurities: false,
          excludeRid: true,
          snapshot: false,
        },
        status: 200,
        responseBody: {
          data: [
            engagementRow('eng-1', 'acc-1', 'Discovery workshop', 12000, 'won'),
            engagementRow('eng-3', 'acc-1', 'Support retainer', 6000, 'open'),
            engagementRow('eng-2', 'acc-1', 'Platform build', 48000, 'open'),
          ],
          totalCount: '3',
        },
      };
    case 10:
      return {
        method: 'POST',
        path: `${base}/objectSets/loadObjects`,
        requestBody: {
          objectSet: {
            type: 'searchAround',
            objectSet: {
              type: 'filter',
              objectSet: { type: 'base', objectType: ENGAGEMENT },
              where: { type: 'eq', field: 'engagementId', value: 'eng-4' },
            },
            link: 'account',
          },
          select: [],
          selectV2: [],
          loadPropertySecurities: false,
          excludeRid: true,
          snapshot: false,
        },
        status: 200,
        responseBody: {
          data: [accountRow('acc-2', 'Globex', 'prospect')],
          totalCount: '1',
        },
      };
    case 11:
      return {
        method: 'POST',
        path: `${base}/objectSets/aggregate`,
        requestBody: {
          objectSet: { type: 'base', objectType: ENGAGEMENT },
          groupBy: [{ type: 'exact', field: 'status' }],
          aggregation: [
            { type: 'count', name: 'count' },
            { type: 'sum', field: 'amount', name: 'amount.sum' },
            { type: 'max', field: 'amount', name: 'amount.max' },
          ],
        },
        status: 200,
        responseBody: {
          accuracy: 'ACCURATE',
          data: [
            {
              group: { status: 'lost' },
              metrics: [
                { name: 'count', value: 1 },
                { name: 'amount.sum', value: 15000 },
                { name: 'amount.max', value: 15000 },
              ],
            },
            {
              group: { status: 'open' },
              metrics: [
                { name: 'count', value: 3 },
                { name: 'amount.sum', value: 84000 },
                { name: 'amount.max', value: 48000 },
              ],
            },
            {
              group: { status: 'won' },
              metrics: [
                { name: 'count', value: 2 },
                { name: 'amount.sum', value: 21000 },
                { name: 'amount.max', value: 12000 },
              ],
            },
          ],
        },
      };
    case 12:
      return {
        method: 'POST',
        path: `${base}/objectSets/aggregate`,
        requestBody: {
          objectSet: {
            type: 'filter',
            objectSet: { type: 'base', objectType: ENGAGEMENT },
            where: { type: 'eq', field: 'accountId', value: 'acc-1' },
          },
          groupBy: [],
          aggregation: [
            { type: 'count', name: 'count' },
            { type: 'avg', field: 'amount', name: 'amount.avg' },
          ],
        },
        status: 200,
        responseBody: {
          accuracy: 'ACCURATE',
          data: [
            {
              group: {},
              metrics: [
                { name: 'count', value: 3 },
                { name: 'amount.avg', value: 22000 },
              ],
            },
          ],
        },
      };
    case 13:
      return {
        method: 'POST',
        path: `${base}/objectSets/loadObjects`,
        requestBody: {
          objectSet: { type: 'base', objectType: ACCOUNT },
          select: [],
          selectV2: [],
          loadPropertySecurities: false,
          excludeRid: true,
          snapshot: true,
          pageSize: 10000,
        },
        status: 200,
        responseBody: {
          data: [
            accountRow('acc-1', 'Acme', 'customer'),
            accountRow('acc-2', 'Globex', 'prospect'),
            accountRow('acc-3', 'Initech', 'customer'),
          ],
          totalCount: '3',
        },
      };
    case 14:
      return {
        method: 'GET',
        path: `${base}/actionTypes/${CREATE_ENGAGEMENT}`,
        requestBody: null,
        status: 200,
        responseBody: meta.actionTypes[CREATE_ENGAGEMENT],
      };
    case 15:
      return {
        method: 'POST',
        path: `${base}/actions/${CREATE_ENGAGEMENT}/apply`,
        requestBody: {
          parameters: { engagementId: 'eng-7', accountId: 'acc-2', title: 'Expansion', amount: 22000 },
          options: { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'ALL_V2_WITH_DELETIONS' },
        },
        status: 200,
        responseBody: {
          validation: { result: 'VALID', submissionCriteria: [], parameters: {} },
          edits: {
            type: 'edits',
            edits: [{ type: 'addObject', objectType: ENGAGEMENT, primaryKey: 'eng-7' }],
            addedObjectCount: 1,
            modifiedObjectsCount: 0,
            deletedObjectsCount: 0,
            addedLinksCount: 0,
            deletedLinksCount: 0,
          },
        },
      };
    case 17:
      return {
        method: 'GET',
        path: `${base}/actionTypes/${SET_ENGAGEMENT_STATUS}`,
        requestBody: null,
        status: 200,
        responseBody: meta.actionTypes[SET_ENGAGEMENT_STATUS],
      };
    case 18:
      return {
        method: 'POST',
        path: `${base}/actions/${SET_ENGAGEMENT_STATUS}/apply`,
        requestBody: {
          parameters: { objectToModifyParameter: 'eng-7', status: 'won' },
          options: { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'ALL_V2_WITH_DELETIONS' },
        },
        status: 200,
        responseBody: {
          validation: { result: 'VALID', submissionCriteria: [], parameters: {} },
          edits: {
            type: 'edits',
            edits: [{ type: 'modifyObject', objectType: ENGAGEMENT, primaryKey: 'eng-7' }],
            addedObjectCount: 0,
            modifiedObjectsCount: 1,
            deletedObjectsCount: 0,
            addedLinksCount: 0,
            deletedLinksCount: 0,
          },
        },
      };
    case 21:
      return {
        method: 'POST',
        path: `${base}/actions/${CREATE_ENGAGEMENT}/apply`,
        requestBody: {
          parameters: { engagementId: 'eng-1', title: 'Duplicate' },
          options: { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'NONE' },
        },
        status: 409,
        responseBody: {
          errorCode: 'CONFLICT',
          errorName: 'ObjectAlreadyExists',
          errorInstanceId: 'd7c26299-1870-4db0-bf9a-0fb82ddf5421',
          parameters: {},
        },
      };
    case 22:
      return {
        method: 'POST',
        path: `${base}/objectSets/loadObjects`,
        requestBody: {
          objectSet: {
            type: 'filter',
            objectSet: { type: 'base', objectType: ENGAGEMENT },
            where: { type: 'eq', field: 'nope', value: 'x' },
          },
          select: [],
          selectV2: [],
          loadPropertySecurities: false,
          excludeRid: true,
          snapshot: false,
        },
        status: 404,
        responseBody: {
          errorCode: 'NOT_FOUND',
          errorName: 'PropertiesNotFound',
          errorInstanceId: 'ebe8005d-11d9-4f56-b2fe-615635d6689d',
          parameters: { objectType: ENGAGEMENT, properties: ['nope'] },
        },
      };
    case 24:
      return {
        method: 'POST',
        path: `${base}/actions/${CREATE_ENGAGEMENT}/apply`,
        requestBody: {
          parameters: { title: 'Validate only' },
          options: { mode: 'VALIDATE_ONLY', returnEdits: 'NONE' },
        },
        status: 200,
        responseBody: {
          validation: {
            result: 'VALID',
            submissionCriteria: [],
            parameters: {
              accountId: { result: 'VALID', evaluatedConstraints: [], required: false },
              amount: { result: 'VALID', evaluatedConstraints: [], required: false },
              title: { result: 'VALID', evaluatedConstraints: [], required: true },
              engagementId: { result: 'VALID', evaluatedConstraints: [], required: false },
            },
          },
        },
      };
    default:
      throw new Error(`No synthetic client exchange ${id}.`);
  }
}
