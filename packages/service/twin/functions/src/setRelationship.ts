/* oxlint-disable typescript/no-explicit-any -- intentional untyped cast to test invalid struct edits at runtime. */
import type { Client, Osdk } from '@osdk/client';
import { createEditBatch, type DateISOString, type Edits, UserFacingError } from '@osdk/functions';
import { StructProbe } from './sdk.ts';

type OntologyEdit = Edits.Object<StructProbe>;

interface Relationship {
  label: string;
  since?: DateISOString;
}

export default function setRelationship(
  client: Client,
  probe: Osdk.Instance<StructProbe>,
  relationship: Relationship,
  mode: string,
): OntologyEdit[] {
  const batch = createEditBatch<OntologyEdit>(client);
  const write = (value: unknown) => batch.update(probe, { relationship: value } as any);

  switch (mode) {
    case 'full':
      write(relationship);

      break;
    case 'label-only':
      write({ label: relationship.label });

      break;
    case 'bad-date':
      write({ label: relationship.label, since: 'not-a-date' });

      break;
    case 'extra-field':
      write({ ...relationship, unknown: 'x' });

      break;
    case 'null':
      write(null);

      break;
    case 'echo':
      write({ label: `echo: ${JSON.stringify(probe.relationship)}`, since: relationship.since });

      break;
    default:
      throw new UserFacingError(`unknown mode: ${mode}`);
  }

  return batch.getEdits();
}

export const config = {
  apiName: 'setRelationship',
};
