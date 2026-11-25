import type { OntologyIr } from '@osdk/client.unstable';
import type { GrantsFile } from './ontology/index.ts';
import { grantsOf, NS, twinIr, USE } from './ontology/stored.test-utils.ts';

export const ACCOUNT = `${NS}Account`;
export const ENGAGEMENT = `${NS}Engagement`;
export const STRUCT_PROBE = `${NS}StructProbe`;
export const SET_ENGAGEMENT_STATUS = `${NS}set-engagement-status`;

const ADMIN_ONLY = [
  ACCOUNT,
  `${NS}create-account`,
  `${NS}delete-account`,
  `${NS}close-account-action`,
  `${NS}set-account-phase`,
  `${NS}copy-account-phase`,
  `${NS}probe-version-check-action`,
  SET_ENGAGEMENT_STATUS,
];

const ADMIN = 'twin:admin';

export function splitGrants(ir: OntologyIr): GrantsFile {
  const grants = grantsOf(ir);

  const narrowed = (map: Readonly<Record<string, string>>) =>
    Object.fromEntries(Object.entries(map).map(([name, slug]) => [name, ADMIN_ONLY.includes(name) ? ADMIN : slug]));

  return {
    permissions: { ...grants.permissions, [ADMIN]: { description: 'Administer the twin' } },
    objectTypes: narrowed(grants.objectTypes),
    actionTypes: narrowed(grants.actionTypes),
    defaultRoles: { admin: ['ontology:install', ADMIN, USE], member: [USE] },
  };
}

export function twinSplitGrants(): GrantsFile {
  return splitGrants(twinIr('0.7.0'));
}

export const MEMBER_ACTION_TYPES = [
  `${NS}create-engagement`,
  `${NS}create-struct-probe`,
  `${NS}delete-engagement`,
  `${NS}delete-struct-probe`,
  `${NS}set-relationship-action`,
  `${NS}set-struct-probe-relationship`,
];

export const HIDDEN_RID = 'ri.actions.main.action-type.7c2cbf1f-5c5b-55c9-83a7-f16211226ef9';

export interface Pair {
  readonly hidden: string;
  readonly unknown: string;
}

export const OBJECT_TYPE: Pair = { hidden: ACCOUNT, unknown: `${NS}Nosuchtype` };
export const ACTION_TYPE: Pair = { hidden: SET_ENGAGEMENT_STATUS, unknown: `${NS}no-such-action` };
export const CAMEL_ACTION: Pair = { hidden: 'setEngagementStatus', unknown: 'noSuchAction' };
export const RID: Pair = { hidden: HIDDEN_RID, unknown: `${HIDDEN_RID.slice(0, -12)}000000000000` };
export const LINK: Pair = { hidden: 'account', unknown: 'nosuchlink' };
