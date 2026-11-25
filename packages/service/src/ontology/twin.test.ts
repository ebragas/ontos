import { describe, expect, it } from 'vitest';

import { compileOrThrow, NS, stored, twinFunctions, twinIr, type TwinVersion } from './stored.test-utils.ts';

interface ExpectedOntology {
  readonly objectTypes: string[];
  readonly properties: Record<string, string[]>;
  readonly links: Record<string, string[]>;
  readonly actionTypes: string[];
  readonly functions: string[];
}

const ACCOUNT = `${NS}Account`;
const ENGAGEMENT = `${NS}Engagement`;
const STRUCT_PROBE = `${NS}StructProbe`;

const cases: [TwinVersion, ExpectedOntology][] = [
  [
    '0.6.3',
    {
      objectTypes: [ACCOUNT, ENGAGEMENT, STRUCT_PROBE],
      properties: {
        [ACCOUNT]: ['accountId', 'name', 'phase'],
        [ENGAGEMENT]: ['accountId', 'amount', 'createdAt', 'engagementId', 'status', 'title'],
        [STRUCT_PROBE]: ['measures', 'probeId', 'relationship'],
      },
      links: { [ACCOUNT]: ['engagements'], [ENGAGEMENT]: ['account'], [STRUCT_PROBE]: [] },
      actionTypes: [
        `${NS}close-account-action`,
        `${NS}copy-account-phase`,
        `${NS}create-account`,
        `${NS}create-engagement`,
        `${NS}create-struct-probe`,
        `${NS}delete-account`,
        `${NS}delete-engagement`,
        `${NS}delete-struct-probe`,
        `${NS}probe-version-check-action`,
        `${NS}set-account-phase`,
        `${NS}set-engagement-status`,
        `${NS}set-relationship-action`,
        `${NS}set-struct-probe-relationship`,
      ],
      functions: ['closeAccount', 'probeVersionCheck', 'setRelationship'],
    },
  ],
  [
    '0.7.0',
    {
      objectTypes: [ACCOUNT, ENGAGEMENT, STRUCT_PROBE],
      properties: {
        [ACCOUNT]: ['accountId', 'active', 'name', 'note', 'phase'],
        [ENGAGEMENT]: ['accountId', 'amount', 'createdAt', 'engagementId', 'status', 'title'],
        [STRUCT_PROBE]: ['measures', 'probeId', 'relationship'],
      },
      links: { [ACCOUNT]: ['engagements'], [ENGAGEMENT]: ['account'], [STRUCT_PROBE]: [] },
      actionTypes: [
        `${NS}close-account-action`,
        `${NS}copy-account-phase`,
        `${NS}create-account`,
        `${NS}create-engagement`,
        `${NS}create-struct-probe`,
        `${NS}delete-account`,
        `${NS}delete-engagement`,
        `${NS}delete-struct-probe`,
        `${NS}probe-version-check-action`,
        `${NS}set-account-phase`,
        `${NS}set-engagement-status`,
        `${NS}set-relationship-action`,
        `${NS}set-struct-probe-relationship`,
      ],
      functions: ['closeAccount', 'probeVersionCheck', 'setRelationship'],
    },
  ],
];

describe('the twin ontology compilation', () => {
  it.each(cases)(
    'the twin %s IR compiles cleanly with its expected Object Types, Properties, Links, Action Types, and Functions',
    (version, expected) => {
      const compiled = compileOrThrow(stored(twinIr(version), { functions: twinFunctions(version) }));

      expect([...compiled.objectTypes.keys()].sort()).toEqual(expected.objectTypes);

      for (const [objectType, properties] of Object.entries(expected.properties)) {
        expect([...(compiled.objectTypes.get(objectType)?.properties.keys() ?? [])].sort(), objectType).toEqual(
          properties,
        );
      }

      for (const [objectType, links] of Object.entries(expected.links)) {
        expect([...(compiled.objectTypes.get(objectType)?.links.keys() ?? [])].sort(), objectType).toEqual(links);
      }

      expect([...compiled.actionTypes.keys()].sort()).toEqual(expected.actionTypes);
      expect([...compiled.functions.keys()].sort()).toEqual(expected.functions);
    },
  );
});
