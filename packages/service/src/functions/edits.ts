import type { Edits } from '@osdk/functions';
import type { Edit, ObjectLocator } from '../actions/index.ts';
import { each, type ApiError, type Fallible } from '../errors/index.ts';
import type {
  CompiledObjectType,
  CompiledOntology,
  EditFunction,
  JsonValue,
  PropertyApiName,
} from '../ontology/index.ts';
import { refused, unsupportedSequence } from './errors.ts';

type FunctionEditKind = Edits.Object<never>['type'] | Edits.Link<never, never>['type'] | Edits.Interface<never>['type'];

const INTERFACE_KINDS: ReadonlySet<string> = new Set<FunctionEditKind>([
  'createObjectForInterface',
  'updateObjectForInterface',
  'deleteObjectForInterface',
]);

interface ObjectReference {
  readonly $apiName?: unknown;
  readonly $primaryKey?: unknown;
}

interface FunctionEdit {
  readonly type?: unknown;
  readonly obj?: ObjectReference & { readonly apiName?: unknown };
  readonly properties?: Readonly<Record<string, JsonValue>>;
  readonly apiName?: unknown;
  readonly source?: ObjectReference;
  readonly target?: ObjectReference;
}

export function* toEdits(returned: unknown, ontology: CompiledOntology, fn: EditFunction): Fallible<Edit[], ApiError> {
  const context = { ontology, fn };

  if (!Array.isArray(returned)) return yield refused(context, 'The Function returned no list of edits.');

  return yield* compile(yield* each(returned, (edit) => toEdit((edit ?? {}) as FunctionEdit, context)), context);
}

interface Context {
  readonly ontology: CompiledOntology;
  readonly fn: EditFunction;
}

function* toEdit(edit: FunctionEdit, context: Context): Fallible<Edit, ApiError> {
  const { type } = edit;

  switch (type) {
    case 'createObject': {
      const objectType = yield* editedType(edit.obj?.apiName, context);
      const properties = yield* values(objectType, edit.properties, context);
      const primaryKey = properties.get(objectType.primaryKey.apiName);

      if (typeof primaryKey !== 'string')
        return yield refused(
          context,
          `A createObject edit of ${objectType.apiName} has no String primary key ${objectType.primaryKey.apiName}.`,
        );

      properties.delete(objectType.primaryKey.apiName);

      return { type: 'addObject', object: { objectType: objectType.apiName, primaryKey }, properties };
    }
    case 'updateObject': {
      const { objectType, object } = yield* editedObject(edit.obj, context);
      const properties = yield* values(objectType, edit.properties, context);

      properties.delete(objectType.primaryKey.apiName);

      return { type: 'modifyObject', object, properties };
    }
    case 'deleteObject':
      return { type: 'deleteObject', object: (yield* editedObject(edit.obj, context)).object };
    case 'addLink':
    case 'removeLink': {
      const source = yield* locator(edit.source, context);

      const side =
        typeof edit.apiName === 'string'
          ? context.ontology.objectTypes.get(source.objectType)?.links.get(edit.apiName)
          : undefined;

      if (!side)
        return yield refused(
          context,
          `A ${type} edit names the Link ${String(edit.apiName)}, which ${source.objectType} does not have.`,
        );

      if (side.via.kind !== 'joinTable') {
        return yield refused(
          context,
          `A ${type} edit names the Link ${side.apiName} of ${source.objectType}, which is not a side of a many-to-many Link Type.`,
        );
      }

      if (!context.fn.provenance.linkTypes.has(side.linkType))
        return yield refused(
          context,
          `The Function edits the Link Type ${side.linkType}, which its Edits type does not name.`,
        );

      const target = yield* locator(edit.target, context);

      if (target.objectType !== side.target) {
        return yield refused(
          context,
          `A ${type} edit of the Link ${side.apiName} names a target of ${target.objectType}, not of ${side.target}.`,
        );
      }

      return { type: type === 'addLink' ? 'addLink' : 'deleteLink', link: side.apiName, source, target };
    }
    default:
      if (typeof type === 'string' && INTERFACE_KINDS.has(type))
        return yield refused(context, `The Function returned a ${type} edit. V1 has no Interfaces.`);

      return yield refused(context, `The Function returned an edit of the unknown kind ${String(type)}.`);
  }
}

function* values(
  objectType: CompiledObjectType,
  properties: Readonly<Record<string, JsonValue>> | undefined,
  context: Context,
): Fallible<Map<PropertyApiName, JsonValue>, ApiError> {
  const entries = Object.entries(properties ?? {}).filter(([key]) => !key.startsWith('$'));
  const derived = entries.find(([key]) => objectType.derived.has(key));

  if (derived)
    return yield refused(
      context,
      `An edit of ${objectType.apiName} names the Property ${derived[0]}, which is a derived property of ${objectType.apiName}. A Function cannot edit a derived property.`,
    );

  const unknown = entries.find(([key]) => !objectType.properties.has(key));

  if (unknown)
    return yield refused(
      context,
      `An edit of ${objectType.apiName} names the Property ${unknown[0]}, which ${objectType.apiName} does not have.`,
    );

  return new Map(entries);
}

function* objectTypeOf(apiName: unknown, context: Context): Fallible<CompiledObjectType, ApiError> {
  const objectType = typeof apiName === 'string' ? context.ontology.objectTypes.get(apiName) : undefined;

  if (!objectType)
    return yield refused(
      context,
      `An edit of the Function names the Object Type ${String(apiName)}, which the Ontology does not have.`,
    );

  return objectType;
}

function* editedType(apiName: unknown, context: Context): Fallible<CompiledObjectType, ApiError> {
  const objectType = yield* objectTypeOf(apiName, context);

  if (!context.fn.provenance.objectTypes.has(objectType.apiName))
    return yield refused(
      context,
      `The Function edits the Object Type ${objectType.apiName}, which its Edits type does not name.`,
    );

  return objectType;
}

function* editedObject(
  reference: ObjectReference | undefined,
  context: Context,
): Fallible<{ objectType: CompiledObjectType; object: ObjectLocator }, ApiError> {
  const objectType = yield* editedType(reference?.$apiName, context);

  return { objectType, object: yield* locator(reference, context) };
}

function* locator(reference: ObjectReference | undefined, context: Context): Fallible<ObjectLocator, ApiError> {
  const objectType = yield* objectTypeOf(reference?.$apiName, context);
  const primaryKey = reference?.$primaryKey;

  if (typeof primaryKey !== 'string')
    return yield refused(
      context,
      `An edit of the Function names an Object of ${objectType.apiName} with no String $primaryKey.`,
    );

  return { objectType: objectType.apiName, primaryKey };
}

function* compile(edits: readonly Edit[], context: Context): Fallible<Edit[], ApiError> {
  const out: (Edit | undefined)[] = [];
  const places = new Map<string, number>();
  const gone = new Set<string>();
  const keyOf = (object: ObjectLocator) => `${object.objectType}\u0000${object.primaryKey}`;

  for (const edit of edits) {
    if (isLinkEdit(edit)) {
      const deleted = [edit.source, edit.target].find((object) => gone.has(keyOf(object)));

      if (deleted)
        return yield refused(
          context,
          `The Function edits ${deleted.objectType} ${deleted.primaryKey} after it deletes it.`,
        );

      out.push(edit);

      continue;
    }

    const key = keyOf(edit.object);

    if (gone.has(key))
      return yield refused(
        context,
        `The Function edits ${edit.object.objectType} ${edit.object.primaryKey} after it deletes it.`,
      );

    if (edit.type === 'deleteObject') {
      out.forEach((other, index) => {
        if (other && isLinkEdit(other) && (keyOf(other.source) === key || keyOf(other.target) === key))
          out[index] = undefined;
      });
    }

    const place = places.get(key);
    const earlier = place === undefined ? undefined : out[place];

    if (place === undefined || !earlier || isLinkEdit(earlier)) {
      places.set(key, out.push(edit) - 1);

      continue;
    }

    const name = `${edit.object.objectType} ${edit.object.primaryKey}`;

    if (earlier.type === 'deleteObject') {
      if (edit.type === 'deleteObject')
        return yield refused(context, `The Function edits ${name} after it deletes it.`);

      return yield unsupportedSequence();
    }

    if (edit.type === 'addObject') return yield unsupportedSequence();

    if (edit.type === 'deleteObject') {
      if (earlier.type === 'addObject') {
        out[place] = undefined;

        places.delete(key);

        gone.add(key);
      } else {
        out[place] = edit;
      }

      continue;
    }

    out[place] = { ...earlier, properties: new Map([...earlier.properties, ...edit.properties]) };
  }

  return out.filter((edit) => edit !== undefined);
}

type LinkEdit = Extract<Edit, { type: 'addLink' | 'deleteLink' }>;

function isLinkEdit(edit: Edit): edit is LinkEdit {
  return edit.type === 'addLink' || edit.type === 'deleteLink';
}
