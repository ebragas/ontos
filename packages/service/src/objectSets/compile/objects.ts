import { jsonForm, quoteName } from '../../db/index.ts';
import { ApiError, type Fallible } from '../../errors/index.ts';
import type { CompiledObjectSet } from './objectSet.ts';
import type { PropertySelector } from './request.ts';
import type { ReturnReason, RowProperty } from './row.ts';
import { objectRids } from './rid.ts';
import type { Params } from './sql.ts';

export const ROW = 'o';

export interface ObjectReader {
  columns(params: Params): string;
  toObject(row: Readonly<Record<string, unknown>>): Record<string, unknown>;
}

interface ReadOptions {
  readonly excludeRid: boolean;
  readonly ontologyRid: string;
  readonly ontologyDerived?: boolean;
  readonly loadDerivedProperties?: boolean;
}

export function* objectReader(
  set: CompiledObjectSet,
  select: readonly PropertySelector[],
  options: ReadOptions,
): Fallible<ObjectReader, ApiError> {
  const { objectType, row } = set;
  const held = row.all();
  const heldNames = new Set(held.map((property) => property.apiName));
  const named = new Set<string>();
  const missing: string[] = [];

  for (const selector of select) {
    const apiName =
      selector.kind === 'property'
        ? selector.apiName
        : selector.kind === 'titleProperty'
          ? objectType.titleKey
          : objectType.primaryKey.apiName;

    if (heldNames.has(apiName)) named.add(apiName);
    else missing.push(apiName);
  }

  if (missing.length > 0)
    return yield new ApiError(404, 'PropertiesNotFound', { objectType: objectType.apiName, properties: missing });

  const all = select.length === 0;
  const withTitle = all || named.has(objectType.titleKey);

  named.add(objectType.primaryKey.apiName);

  const objectTypeReason =
    options.ontologyDerived === true
      ? 'requestFlag'
      : options.ontologyDerived === undefined && options.loadDerivedProperties === true
        ? 'setting'
        : undefined;

  const reasonOf = (property: RowProperty): ReturnReason | undefined => {
    if (!all) return named.has(property.apiName) ? 'select' : undefined;

    return property.derived?.form === 'objectType' ? objectTypeReason : 'select';
  };

  const returned = held.flatMap((property) => {
    const reason = reasonOf(property);

    return reason === undefined ? [] : [{ property, reason }];
  });

  const properties = returned.map(({ property }) => property);
  const rid = objectRids(options.ontologyRid, objectType.apiName);

  const reads = returned.map(({ property, reason }) => ({ type: property.type, sql: row.select(property, reason) }));
  const columnOf = (apiName: string) => propertyColumn(properties.findIndex((p) => p.apiName === apiName));
  const keyColumn = columnOf(objectType.primaryKey.apiName);
  const titleColumn = withTitle ? columnOf(objectType.titleKey) : undefined;

  return {
    columns: (params) =>
      reads
        .map((read, index) => `${jsonForm(read.type, read.sql(ROW, params))} AS ${quoteName(propertyColumn(index))}`)
        .join(', '),
    toObject: (row) => {
      const key = String(row[keyColumn]);
      const title = titleColumn === undefined ? null : row[titleColumn];

      const values = properties
        .map((p, index): [string, unknown] => [p.apiName, row[propertyColumn(index)]])
        .filter(([, value]) => value !== null && value !== undefined);

      return Object.fromEntries([
        ['__apiName', objectType.apiName],
        ['__primaryKey', key],
        ...(title !== null && title !== undefined
          ? [
              [
                '__title',
                typeof title === 'string' || typeof title === 'number' || typeof title === 'boolean'
                  ? String(title)
                  : JSON.stringify(title),
              ],
            ]
          : []),
        ...(options.excludeRid ? [] : [['__rid', rid(key)]]),
        ...values,
      ]) as Record<string, unknown>;
    },
  };
}

function propertyColumn(index: number): string {
  return `p${index}`;
}
