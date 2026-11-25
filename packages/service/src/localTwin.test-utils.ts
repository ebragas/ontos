import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GATE_DEPLOYMENT_FILE, twinFunctionsApp } from '../../cli/src/apps.test-utils.ts';

export const LOCAL_APP = 'twin';

const deploymentFile = (() => {
  const { production, ...gate } = JSON.parse(GATE_DEPLOYMENT_FILE) as {
    production: { workosClientId: string; authkitDomain: string };
  };

  const staging = {
    ...production,
    baseUrl: 'https://twin-staging.ontos.example',
    trustedGithubRepository: 'example/twin-ontology',
    trustedGithubEnvironment: 'ontology-staging',
    mcp: false,
  };

  return JSON.stringify({ ...gate, staging });
})();

export const localTwin = (): string => twinFunctionsApp({ '.ontology/deployment.json': deploymentFile });

export function renamedTwin(): string {
  const folder = localTwin();

  for (const file of ['ontology/src/ontology.mts', 'ontology/src/grants.json']) {
    const path = join(folder, file);

    writeFileSync(path, readFileSync(path, 'utf8').replace(/create-account(['"])/, 'make-account$1'));
  }

  return folder;
}
