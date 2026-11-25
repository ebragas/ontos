import type {
  ActionResults,
  ApplyActionMode,
  ObjectEdit,
  ReturnEditsMode,
  SyncApplyActionResponseV2,
  ValidateActionResponseV2,
} from '@osdk/foundry.ontologies';
import type {
  CompiledLink,
  CompiledOntology,
  JoinTableSide,
  JsonValue,
  LinkTypeApiName,
  ParameterId,
} from '../../ontology/index.ts';
import { invariant } from '../../errors/index.ts';
import type { CheckedEdit, Edit } from '../edit.ts';
import type { CriteriaCheck } from './criteria.ts';
import type { ParameterCheck } from './parameters.ts';

export function validationResult(
  parameters: ParameterCheck,
  criteria: CriteriaCheck,
  mode: ApplyActionMode,
  defaults: ReadonlyMap<ParameterId, JsonValue>,
): ValidateActionResponseV2 {
  const valid = criteria.valid && [...parameters.results.values()].every((parameter) => parameter.result === 'VALID');

  const results = [...parameters.results].map(([id, result]) => {
    const defaultValue = defaults.get(id);

    return [id, defaultValue === undefined ? result : { ...result, defaultValue }] as const;
  });

  return {
    result: valid ? 'VALID' : 'INVALID',
    submissionCriteria: [...criteria.results],
    parameters: valid && mode === 'VALIDATE_AND_EXECUTE' ? {} : Object.fromEntries(results),
  };
}

const LARGE_SCALE_EDITS = 5_000;

export function appliedResponse(
  operationId: string,
  validation: ValidateActionResponseV2,
  edits: readonly CheckedEdit[],
  returnEdits: ReturnEditsMode,
  ontology: CompiledOntology,
): SyncApplyActionResponseV2 {
  if (returnEdits === 'NONE' || edits.length === 0) return { operationId, validation };

  const large = largeScaleEdits(edits, returnEdits);

  return { operationId, validation, edits: large ?? actionResults(edits, returnEdits, ontology) };
}

function largeScaleEdits(edits: readonly Edit[], returnEdits: ReturnEditsMode): ActionResults | undefined {
  if (returnEdits !== 'ALL_V2_WITH_DELETIONS') return undefined;

  const objectTypes = new Set<string>();

  for (const edit of edits) {
    if (edit.type !== 'addObject' && edit.type !== 'modifyObject') return undefined;

    objectTypes.add(edit.object.objectType);
  }

  const [objectType] = objectTypes;

  if (objectTypes.size !== 1 || objectType === undefined || edits.length <= LARGE_SCALE_EDITS) return undefined;

  return { type: 'largeScaleEdits', editedObjectTypes: [objectType] };
}

function actionResults(
  edits: readonly Edit[],
  returnEdits: 'ALL' | 'ALL_V2_WITH_DELETIONS',
  ontology: CompiledOntology,
): ActionResults {
  const listed = returnEdits === 'ALL' ? edits.filter((edit) => edit.type !== 'deleteObject') : edits;

  return {
    type: 'edits',
    edits: listed.map((edit) => objectEdit(edit, ontology)),
    addedObjectCount: edits.filter((edit) => edit.type === 'addObject').length,
    modifiedObjectsCount: edits.filter((edit) => edit.type === 'modifyObject').length,
    deletedObjectsCount: edits.filter((edit) => edit.type === 'deleteObject').length,
    addedLinksCount: edits.filter((edit) => edit.type === 'addLink').length,
    deletedLinksCount: edits.filter((edit) => edit.type === 'deleteLink').length,
  };
}

function objectEdit(edit: Edit, ontology: CompiledOntology): ObjectEdit {
  switch (edit.type) {
    case 'addObject':
    case 'modifyObject':
    case 'deleteObject':
      return { type: edit.type, primaryKey: edit.object.primaryKey, objectType: edit.object.objectType };
    case 'addLink':
    case 'deleteLink': {
      const linkType = ontology.linkTypes.get(
        ontology.objectTypes.get(edit.source.objectType)?.links.get(edit.link)?.linkType ?? '',
      );

      invariant(
        linkType?.storage.kind === 'joinTable',
        `The Object Type ${edit.source.objectType} has no many-to-many Link side ${edit.link}.`,
      );

      const { a, b } = linkType.storage;
      const aToB = sideOf(ontology, linkType.apiName, a);

      const [aSide, bSide] =
        edit.link === aToB.apiName && edit.source.objectType === a.objectType
          ? [edit.source, edit.target]
          : [edit.target, edit.source];

      return {
        type: edit.type,
        linkTypeApiNameAtoB: aToB.apiName,
        linkTypeApiNameBtoA: sideOf(ontology, linkType.apiName, b).apiName,
        aSideObject: { primaryKey: aSide.primaryKey, objectType: aSide.objectType },
        bSideObject: { primaryKey: bSide.primaryKey, objectType: bSide.objectType },
      };
    }
  }
}

function sideOf(ontology: CompiledOntology, linkType: LinkTypeApiName, side: JoinTableSide): CompiledLink {
  const links = ontology.objectTypes.get(side.objectType)?.links.values() ?? [];

  const found = [...links].find(
    (link) => link.linkType === linkType && link.via.kind === 'joinTable' && link.via.sourceColumn === side.column,
  );

  invariant(found, `The Link Type ${linkType} has no side on ${side.objectType}.`);

  return found;
}
