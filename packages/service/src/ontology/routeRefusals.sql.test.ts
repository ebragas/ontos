import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handle } from '../handler/index.ts';
import { startInstalled, type InstalledOntology } from '../handler/handler.test-utils.ts';
import { errorAnswer } from '../service.test-utils.ts';
import { NS, ONTOLOGY_RID, twinFunctions, twinIr } from './stored.test-utils.ts';

let installed: InstalledOntology;
let token: string;

beforeAll(async () => {
  installed = await startInstalled(twinIr('0.6.3'), twinFunctions('0.6.3'));

  token = await installed.issuer.workos();
}, 120_000);

afterAll(async () => {
  await installed.stop();
});

async function answerOf(path: string): Promise<unknown> {
  const response = await handle(
    new Request(`http://localhost/api/v2/ontologies/${ONTOLOGY_RID}/${path}`, {
      headers: { authorization: `Bearer ${token}` },
    }),
    installed.input,
  );

  const answer = errorAnswer({ status: response.status, body: await response.json() });

  return { ...answer, headers: Object.fromEntries(response.headers) };
}

const routes: readonly (readonly [string, string])[] = [
  ['an unknown Object Type in fullMetadata', 'objectTypes/Nope/fullMetadata'],
  ['an unknown Object Type', 'objectTypes/Nope'],
  ['an unknown Action Type', 'actionTypes/nope'],
  ['an Action Type by its published name', `actionTypes/${NS}closeAccountAction`],
  ['an unknown Action Type by RID', 'actionTypes/byRid/ri.actions.main.action-type.nope'],
  ['a page size that is not a number', 'objectTypes?pageSize=abc'],
  ['a page size of 0', 'objectTypes?pageSize=0'],
  ['a negative page size', 'actionTypes?pageSize=-5'],
  ['a page token that is not base64', 'objectTypes?pageToken=%25%25'],
  ['a page token that is not a name', `actionTypes?pageToken=${Buffer.from('5', 'utf8').toString('base64url')}`],
];

describe('service/http-api#errors', () => {
  for (const [name, path] of routes) {
    it(`the route answers ${name}`, async () => {
      expect(await answerOf(path)).toMatchSnapshot();
    });
  }
});
