import { type Fallible } from '../../errors/index.ts';
import type {
  CompiledFunction,
  CompiledLinkType,
  CompiledObjectType,
  CompiledParameter,
  FunctionApiName,
  LinkTypeApiName,
  ObjectTypeApiName,
  ParameterId,
  PropertyApiName,
} from '../compiled/index.ts';
import { CompileError } from '../compiled/stored.ts';
import { record, string } from '../model/shape.ts';

export interface ActionTypeContext {
  readonly objectTypes: ReadonlyMap<ObjectTypeApiName, CompiledObjectType>;
  readonly linkTypes: ReadonlyMap<LinkTypeApiName, CompiledLinkType>;
  readonly functions: ReadonlyMap<FunctionApiName, CompiledFunction>;
  readonly readOnly: ReadonlySet<ObjectTypeApiName>;
  readonly namespace: string;
}

export type Parameters = ReadonlyMap<ParameterId, CompiledParameter>;

export function* objectParameter(
  id: unknown,
  path: string,
  owner: string,
  parameters: Parameters,
): Fallible<ObjectTypeApiName, CompileError> {
  const parameterId = yield* string(id, path);
  const parameter = parameters.get(parameterId);

  if (parameter?.type.kind !== 'object')
    return yield new CompileError(`${owner} uses ${parameterId}, which is not an Object reference parameter of it.`);

  return parameter.type.objectType;
}

export function* checkParameter(
  id: unknown,
  path: string,
  owner: string,
  parameters: Parameters,
): Fallible<ParameterId, CompileError> {
  const parameterId = yield* string(id, path);

  if (!parameters.has(parameterId))
    return yield new CompileError(`${owner} uses the parameter ${parameterId}, which it does not have.`);

  return parameterId;
}

export function* objectParameterProperty(
  value: unknown,
  path: string,
  owner: string,
  parameters: Parameters,
  context: ActionTypeContext,
): Fallible<{ parameter: ParameterId; property: PropertyApiName }, CompileError> {
  const source = yield* record(value, path);
  const parameter = yield* checkParameter(source['parameterId'], `${path}.parameterId`, owner, parameters);
  const objectType = yield* objectParameter(parameter, `${path}.parameterId`, owner, parameters);
  const property = yield* string(source['propertyTypeId'], `${path}.propertyTypeId`);

  if (!context.objectTypes.get(objectType)?.properties.has(property)) {
    return yield new CompileError(
      `${owner} reads the Property ${property} of the parameter ${parameter}, which its Object Type ${objectType} does not have.`,
    );
  }

  return { parameter, property };
}
