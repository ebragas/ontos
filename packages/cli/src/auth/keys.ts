import type { Target } from '../targets.ts';

export const TOKEN_VARIABLES: readonly string[] = [
  'ONTOLOGY_TOKEN',
  'ACTIONS_ID_TOKEN_REQUEST_URL',
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
];

export const storeKey = (target: Target): string =>
  `${target.domain ? `${target.domain}/` : ''}${target.app}/${target.environment}${target.testUser ? '-test-user' : ''}`;

export const loginCommand = (target: Target): string =>
  target.urlOnly
    ? `ontos login --url ${target.url}${target.testUser ? ' --test-user' : ''}`
    : `ontos login --app ${target.app} --env ${target.environment}${target.testUser ? ' --test-user' : ''}`;

export const noOrganizationStep = (target: Target): string =>
  `This token has no Organization. Run ${loginCommand(target)}. If you belong to none, join or create an Organization.`;

export const nextStep = (target: Target): string =>
  `If you belong to an Organization, run ${loginCommand(target)} --org <id>. If not, join or create an Organization.`;
