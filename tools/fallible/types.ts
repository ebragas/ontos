import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { NO_RETURNED_VALUE, SIMPLE_NON_OBJECT } from './ast.ts';

const HELPER_FILE = fileURLToPath(new URL('../../packages/service/src/errors/fallible.ts', import.meta.url));
const HELPER_DIR = fileURLToPath(new URL('../../packages/service/src/errors/fallible/', import.meta.url));

export function isHelperFile(file: string): boolean {
  const resolved = path.resolve(file);

  return resolved === HELPER_FILE || resolved.startsWith(HELPER_DIR);
}

export interface TypeAnalysis {
  readonly isStream: (type: ts.Type) => boolean;
  readonly isFallible: (type: ts.Type) => boolean;
  readonly carries: (type: ts.Type, depth?: number) => boolean;
  readonly fallibleArray: (type: ts.Type | undefined) => boolean;
  readonly outside: (node: ts.Node) => string | undefined;
  readonly hasTypeParameter: (type: ts.Type) => boolean;
  readonly declaredParameter: (call: ts.CallExpression | ts.NewExpression, index: number) => ts.Type | undefined;
  readonly parameterOf: (call: ts.CallExpression | ts.NewExpression, index: number) => ts.Type | undefined;
  readonly returned: (fn: ts.SignatureDeclaration) => string | undefined;
}

export function createTypeAnalysis(checker: ts.TypeChecker): TypeAnalysis {
  const parts = (type: ts.Type): readonly ts.Type[] => (type.isUnion() ? type.types : [type]);
  const streamCache = new Map<ts.Type, boolean>();
  const fallibleCache = new Map<ts.Type, boolean>();
  const carriesCache = new Map<ts.Type, boolean>();
  const thenableCache = new Map<ts.Type, boolean>();

  const generators = (type: ts.Type): (readonly ts.Type[])[] =>
    parts(type)
      .filter((part) => ['Generator', 'AsyncGenerator'].includes(part.getSymbol()?.getName() ?? ''))
      .map((part) => checker.getTypeArguments(part as ts.TypeReference));

  const isStream = (type: ts.Type): boolean => {
    if ((type.flags & SIMPLE_NON_OBJECT) !== 0) return false;

    const cached = streamCache.get(type);

    if (cached !== undefined) return cached;

    const result = generators(type).some(
      ([, returned, next]) =>
        (next === undefined || (next.flags & ts.TypeFlags.Never) === 0) &&
        returned !== undefined &&
        parts(returned).some((kind) => (kind.flags & NO_RETURNED_VALUE) === 0),
    );

    streamCache.set(type, result);

    return result;
  };

  function isFallible(type: ts.Type): boolean {
    if ((type.flags & SIMPLE_NON_OBJECT) !== 0) return false;

    const cached = fallibleCache.get(type);

    if (cached !== undefined) return cached;

    const result =
      isStream(type) ||
      generators(type).some(([, , next]) => next !== undefined && (next.flags & ts.TypeFlags.Never) !== 0);

    fallibleCache.set(type, result);

    return result;
  }

  function carries(type: ts.Type, depth = 0): boolean {
    if ((type.flags & SIMPLE_NON_OBJECT) !== 0) return false;

    if (depth === 0) {
      const cached = carriesCache.get(type);

      if (cached !== undefined) return cached;
    }

    let result = isFallible(type);

    if (!result && depth <= 4) {
      const awaited = checker.getAwaitedType(type);

      if (awaited && awaited !== type && carries(awaited, depth + 1)) result = true;
      else
        result = parts(type).some(
          (part) =>
            checker.isArrayType(part) &&
            checker.getTypeArguments(part as ts.TypeReference).some((element) => carries(element, depth + 1)),
        );
    }

    if (depth === 0) carriesCache.set(type, result);

    return result;
  }

  const fallibleArray = (type: ts.Type | undefined): boolean =>
    type !== undefined &&
    parts(type).some(
      (part) => checker.isArrayType(part) && checker.getTypeArguments(part as ts.TypeReference).some(isFallible),
    );

  function helperCall(node: ts.Node, names?: readonly string[]): boolean {
    if (!ts.isCallExpression(node)) return false;

    const declaration = checker.getResolvedSignature(node)?.getDeclaration();

    if (!declaration || !isHelperFile(declaration.getSourceFile().fileName)) return false;

    return names === undefined || names.includes((declaration as ts.FunctionDeclaration).name?.text ?? '');
  }

  const insideBridge = (node: ts.Node): boolean =>
    ts.findAncestor(
      node.parent,
      (at) =>
        (ts.isArrowFunction(at) || ts.isFunctionExpression(at)) &&
        ts.isCallExpression(at.parent) &&
        at.parent.arguments[0] === at &&
        helperCall(at.parent, ['attempt', 'caught']),
    ) !== undefined;

  const thenable = (type: ts.Type): boolean => {
    const cached = thenableCache.get(type);

    if (cached !== undefined) return cached;

    const result = parts(type).some(
      (part) => checker.getPropertyOfType(checker.getApparentType(part), 'then') !== undefined,
    );

    thenableCache.set(type, result);

    return result;
  };

  function outside(node: ts.Node): string | undefined {
    if (insideBridge(node)) return undefined;

    if (ts.isForOfStatement(node))
      return 'for await reads a stream outside attempt or caught, so its error passes as a throw';

    if (!ts.isAwaitExpression(node)) return undefined;

    let operand: ts.Expression = node.expression;

    while (ts.isParenthesizedExpression(operand)) operand = operand.expression;

    const type = checker.getTypeAtLocation(operand);

    if (isFallible(type) || !thenable(type) || helperCall(operand)) return undefined;

    return 'awaits an outside call outside attempt or caught, so its rejection passes as a throw';
  }

  const hasTypeParameter = (type: ts.Type): boolean =>
    parts(type).some(
      (part) =>
        (part.flags & ts.TypeFlags.TypeParameter) !== 0 ||
        ((part as ts.TypeReference).typeArguments ?? []).some(hasTypeParameter),
    );

  function declaredParameter(call: ts.CallExpression | ts.NewExpression, index: number): ts.Type | undefined {
    const declaration = checker.getResolvedSignature(call)?.getDeclaration();

    if (!declaration || !('parameters' in declaration)) return undefined;

    const parameters = declaration.parameters;
    const parameter = parameters[Math.min(index, parameters.length - 1)];

    if (!parameter) return undefined;

    const type = checker.getTypeAtLocation(parameter);

    if (parameter.dotDotDotToken && checker.isArrayType(type))
      return checker.getTypeArguments(type as ts.TypeReference)[0];

    return type;
  }

  function parameterOf(call: ts.CallExpression | ts.NewExpression, index: number): ts.Type | undefined {
    const signature = checker.getResolvedSignature(call);
    const parameters = signature?.getParameters() ?? [];
    const parameter = parameters[Math.min(index, parameters.length - 1)];

    if (!parameter) return undefined;

    const type = checker.getTypeOfSymbol(parameter);

    const rest =
      parameter.valueDeclaration &&
      ts.isParameter(parameter.valueDeclaration) &&
      parameter.valueDeclaration.dotDotDotToken;

    return rest && checker.isArrayType(type) ? checker.getTypeArguments(type as ts.TypeReference)[0] : type;
  }

  function returned(fn: ts.SignatureDeclaration): string | undefined {
    let target: ts.Type | undefined;

    if (fn.type) target = checker.getTypeFromTypeNode(fn.type);
    else if (
      (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) &&
      fn.parent &&
      (ts.isCallExpression(fn.parent) || ts.isNewExpression(fn.parent))
    ) {
      const index = fn.parent.arguments?.indexOf(fn) ?? -1;
      const parameter = index < 0 ? undefined : declaredParameter(fn.parent, index);

      const signature =
        parameter && parts(checker.getNonNullableType(parameter)).flatMap((part) => part.getCallSignatures())[0];

      target = signature?.getReturnType();

      if (target && !carries(target) && hasTypeParameter(target) && !carries(checker.getTypeAtLocation(fn.parent)))
        return `returned to ${checker.typeToString(target)}, and the outer call drops it`;
    } else if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) {
      target = checker.getContextualType(fn)?.getCallSignatures()[0]?.getReturnType();
    }

    if (!target || carries(target) || hasTypeParameter(target)) return undefined;

    return `returned to a caller that takes ${checker.typeToString(target)}`;
  }

  return {
    isStream,
    isFallible,
    carries,
    fallibleArray,
    outside,
    hasTypeParameter,
    declaredParameter,
    parameterOf,
    returned,
  };
}
