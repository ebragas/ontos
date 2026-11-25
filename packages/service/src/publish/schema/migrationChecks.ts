import { ApiError, unsupportedFeature, type Fallible } from '../../errors/index.ts';
import type { CompiledActionType, CompiledObjectType, CompiledOntology } from '../../ontology/index.ts';
import type { SchemaMigration } from '../index.ts';
import { canonical } from './tableSql.ts';

type Kind = SchemaMigration['type'];

const OUTSIDE_V1: Readonly<Record<string, string>> = {
  cast: 'Cast property to new type',
  revert: 'Revert migration',
  dropStructField: 'Drop all struct field edits',
  renameStructField: 'Move struct field edits',
  castStructField: 'Cast struct field to new type',
  renameDatasource: 'Move edits to a new datasource',
};

export function migrationOutsideV1(kind: string): ApiError {
  return unsupportedFeature(OUTSIDE_V1[kind] ?? `Schema migration ${kind}`);
}

export function needsMigration(change: string, schemaMigrations: readonly Kind[]): ApiError {
  return new ApiError(400, 'Default:InvalidArgument', { change, schemaMigrations });
}

export function activeStatus(change: string): ApiError {
  return new ApiError(400, 'Default:InvalidArgument', { change, status: 'active', requiredStatus: 'deprecated' });
}

export function invalidMove(change: string, reason: { primaryKey: string } | { target: string }): ApiError {
  return new ApiError(400, 'Default:InvalidArgument', { change, ...reason });
}

function breakingParameterChange(before: CompiledActionType, after: CompiledActionType): string | undefined {
  const of = `of Action Type ${before.apiName}`;

  for (const old of before.parameters.values()) {
    const next = after.parameters.get(old.id);

    if (!next) return `Delete parameter ${old.id} ${of}`;

    if (canonical(old.type) !== canonical(next.type)) return `Change the type of parameter ${old.id} ${of}`;

    if (!old.required && next.required) return `Make parameter ${old.id} required ${of}`;
  }

  for (const next of after.parameters.values()) {
    if (next.required && !before.parameters.has(next.id)) return `Create required parameter ${next.id} ${of}`;
  }

  return undefined;
}

export function* checkActionType(
  before: CompiledActionType,
  after: CompiledActionType | undefined,
  standIns: boolean,
): Fallible<void, ApiError> {
  if (before.status !== 'active') return;

  if (!after) return yield activeStatus(`Delete Action Type ${before.apiName}`);

  if (standIns && after.logic.kind === 'function') return;

  const change = breakingParameterChange(before, after);

  if (change) return yield activeStatus(change);
}

export function* checkLinkSides(
  before: CompiledObjectType,
  after: CompiledObjectType,
  current: CompiledOntology,
  ontology: CompiledOntology,
): Fallible<void, ApiError> {
  const hasSide = (type: CompiledObjectType, side: string, linkType: string) =>
    type.links.get(side)?.linkType === linkType;

  for (const side of before.links.values()) {
    if (current.linkTypes.get(side.linkType)?.status !== 'active' || !ontology.linkTypes.has(side.linkType)) continue;

    if (hasSide(after, side.apiName, side.linkType)) continue;

    const renamed = [...after.links.values()].find(
      (s) => s.linkType === side.linkType && !hasSide(before, s.apiName, s.linkType),
    );

    if (renamed)
      return yield activeStatus(`Rename Link side ${side.apiName} to ${renamed.apiName} of Link Type ${side.linkType}`);
  }
}
