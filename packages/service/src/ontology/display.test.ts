import type { OntologyIr, OntologyIrObjectTypeBlockDataV2 } from '@osdk/client.unstable';
import { describe, expect, it } from 'vitest';
import { CompileError } from './index.ts';
import type { PublishedFunctions } from '../publish/index.ts';
import {
  convertOrThrow,
  irOf,
  NS,
  ONTOLOGY_RID,
  stringProperty,
  twinFunctions,
  twinIr,
  twinObjectType,
  unchecked,
} from './stored.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const CREATE_ACCOUNT = `${NS}create-account`;

function account(change: (block: OntologyIrObjectTypeBlockDataV2) => void): OntologyIr {
  const block = twinObjectType('Account');

  block.objectType.propertyTypes['notes'] = stringProperty('notes');

  change(block);

  return irOf(block);
}

function createAccount(change: (metadata: Record<string, unknown>) => void): OntologyIr {
  const ir = twinIr('0.4.0');
  const block = ir.ontology.actionTypes[CREATE_ACCOUNT];

  if (!block) throw new Error('The twin 0.4.0 IR has no create-account.');

  change(unchecked(block.actionType.metadata));

  return ir;
}

function metadataOf(ir: OntologyIr) {
  return convertOrThrow({ ir, osdkSet: {}, validateOnly: true, functions: twinFunctions('0.4.0') }, ONTOLOGY_RID, 1)
    .metadata;
}

function refusal(ir: OntologyIr, functions?: PublishedFunctions): string {
  try {
    convertOrThrow({ ir, osdkSet: {}, validateOnly: true, ...(functions ? { functions } : {}) }, ONTOLOGY_RID, 1);
  } catch (error) {
    if (error instanceof CompileError) return error.message;

    throw error;
  }

  throw new Error('convert accepted the IR.');
}

describe('the display values of compile', () => {
  it('service/code-layout#seams: the converter shows the display values that compile parsed', () => {
    const ir = account((block) => {
      const notes = block.objectType.propertyTypes['notes'];

      if (!notes) throw new Error('The Account has no notes.');

      notes.displayMetadata = { displayName: 'Notes', description: 'Free text.', visibility: 'PROMINENT' };
      notes.status = { type: 'deprecated', deprecated: { message: 'Use title.', deadline: '2027-01-01T00:00:00Z' } };
    });

    const property = convertOrThrow({ ir, osdkSet: {}, validateOnly: true }, ONTOLOGY_RID, 1).metadata.objectTypes[
      ACCOUNT
    ]?.objectType.properties['notes'];

    expect(property).toMatchObject({
      displayName: 'Notes',
      description: 'Free text.',
      visibility: 'PROMINENT',
      status: { type: 'deprecated', message: 'Use title.', deadline: '2027-01-01T00:00:00Z' },
    });
  });

  it('service/code-layout#seams: refuses an Object Type icon with no blueprint, and the error names the field', () => {
    const ir = account((block) => {
      block.objectType.displayMetadata.icon = unchecked({ type: 'blueprint' });
    });

    expect(refusal(ir)).toBe(
      `The IR field ontology.objectTypes.${ACCOUNT}.objectType.displayMetadata.icon.blueprint is not an object.`,
    );
  });

  it('service/code-layout#seams: refuses a Property type class with no name, and the error names the field', () => {
    const ir = account((block) => {
      const notes = block.objectType.propertyTypes['notes'];

      if (notes) notes.typeClasses = unchecked([{ kind: 'render_hint' }]);
    });

    expect(refusal(ir)).toBe(
      `The IR field ontology.objectTypes.${ACCOUNT}.objectType.propertyTypes.notes.typeClasses.0.name is not a string.`,
    );
  });

  it('service/code-layout#seams: refuses a deprecated Property status with no deadline, and the error names the field', () => {
    const ir = account((block) => {
      const notes = block.objectType.propertyTypes['notes'];

      if (notes) notes.status = unchecked({ type: 'deprecated', deprecated: { message: 'Use title.' } });
    });

    expect(refusal(ir)).toBe(
      `The IR field ontology.objectTypes.${ACCOUNT}.objectType.propertyTypes.notes.status.deprecated.deadline is not a string.`,
    );
  });

  it('service/code-layout#seams: refuses a visibility that is not NORMAL, PROMINENT, or HIDDEN, and the error names it', () => {
    const ir = account((block) => {
      block.objectType.displayMetadata.visibility = unchecked('LOUD');
    });

    expect(refusal(ir)).toBe(
      `The IR field ontology.objectTypes.${ACCOUNT}.objectType.displayMetadata.visibility has the visibility LOUD. The visibilities are NORMAL, PROMINENT, and HIDDEN.`,
    );
  });

  it('service/code-layout#seams: refuses an Object Type with no visibility, and the error names the field', () => {
    const ir = account((block) => {
      block.objectType.displayMetadata.visibility = unchecked(undefined);
    });

    expect(refusal(ir)).toBe(
      `The IR field ontology.objectTypes.${ACCOUNT}.objectType.displayMetadata.visibility is not a string.`,
    );
  });

  it('service/code-layout#seams: refuses an Action Type parameter with no display name, and the error names the field', () => {
    const ir = createAccount((metadata) => {
      const parameters = metadata['parameters'] as Record<string, { displayMetadata: Record<string, unknown> }>;
      const name = parameters['name'];

      if (name) delete name.displayMetadata['displayName'];
    });

    expect(refusal(ir, twinFunctions('0.4.0'))).toBe(
      `The IR field ontology.actionTypes.${CREATE_ACCOUNT}.actionType.metadata.parameters.name.displayMetadata.displayName is not a string.`,
    );
  });

  it('ontology/object-link-types/object-types#statuses: an Action Type status deprecated becomes DEPRECATED, and the status example becomes EXPERIMENTAL', () => {
    const deprecated = createAccount((metadata) => {
      metadata['status'] = {
        type: 'deprecated',
        deprecated: { message: 'Use open-account.', deadline: '2027-01-01T00:00:00Z' },
      };
    });

    expect(metadataOf(deprecated).actionTypes[CREATE_ACCOUNT]?.status).toBe('DEPRECATED');

    const example = createAccount((metadata) => {
      metadata['status'] = { type: 'example', example: {} };
    });

    expect(metadataOf(example).actionTypes[CREATE_ACCOUNT]?.status).toBe('EXPERIMENTAL');
  });

  it('ontology/object-link-types/object-types#parts: refuses an Object Type with an empty display name or no plural display name', () => {
    expect(refusal(account((block) => (block.objectType.displayMetadata.displayName = '')))).toBe(
      `Object Type ${ACCOUNT} has no display name.`,
    );

    expect(
      refusal(account((block) => (block.objectType.displayMetadata.pluralDisplayName = unchecked(undefined)))),
    ).toBe(`Object Type ${ACCOUNT} has no plural display name.`);
  });

  it('ontology/object-link-types/properties#parts: refuses a Property with an empty display name', () => {
    const ir = account((block) => {
      const notes = block.objectType.propertyTypes['notes'];

      if (notes) notes.displayMetadata.displayName = '';
    });

    expect(refusal(ir)).toBe(`Property notes of Object Type ${ACCOUNT} has no display name.`);
  });
});
