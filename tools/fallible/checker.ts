import path from 'node:path';
import ts from 'typescript';
import { isTypeOnlySubtree, isValueReference, isWriteTarget, passesThrough } from './ast.ts';
import { createTypeAnalysis, isHelperFile } from './types.ts';

const D1_MARKER = /^\s*\/\/ (?:oxlint-disable-next-line fallible\/no-throw -- )?D1: \S/;
const READ_STREAM = 'Read it with `step` or `mapStream`, or pass it up with `yield*`.';

export interface Hit {
  readonly kind: 'drop' | 'outside';
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

export interface Report {
  readonly hits: readonly Hit[];
  readonly files: number;
  readonly calls: number;
  readonly unmatched: readonly string[];
}

export function checkProgram(
  program: ts.Program,
  own: ReadonlySet<string>,
  inScope: (file: string) => boolean,
): { hits: Hit[]; calls: string[]; files: string[] } {
  const scopeCache = new Map<string, boolean>();

  const cachedScope = (file: string): boolean => {
    const cached = scopeCache.get(file);

    if (cached !== undefined) return cached;

    const result = inScope(file);

    scopeCache.set(file, result);

    return result;
  };

  const check = checkerOf(program.getTypeChecker(), cachedScope);
  const hits: Hit[] = [];
  const calls: string[] = [];
  const files: string[] = [];

  for (const file of program.getSourceFiles()) {
    if (!own.has(path.resolve(file.fileName))) continue;

    files.push(path.resolve(file.fileName));

    const result = check(file);

    hits.push(...result.hits);

    calls.push(...result.calls);
  }

  return { hits, calls, files };
}

function checkerOf(
  checker: ts.TypeChecker,
  inScope: (file: string) => boolean,
): (file: ts.SourceFile) => { hits: Hit[]; calls: string[] } {
  const {
    isStream,
    isFallible,
    carries,
    fallibleArray,
    outside,
    hasTypeParameter,
    declaredParameter,
    parameterOf,
    returned,
  } = createTypeAnalysis(checker);

  return (file) => {
    const fileInScope = inScope(file.fileName);
    const references = new Map<ts.Symbol, ts.Identifier[]>();

    const visitIdentifiers = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) {
        const symbol = checker.getSymbolAtLocation(node);

        if (symbol) {
          const list = references.get(symbol);

          if (list) list.push(node);
          else references.set(symbol, [node]);
        }
      }

      ts.forEachChild(node, visitIdentifiers);
    };

    let indexed = false;

    function unread(name: ts.Identifier): boolean {
      if (!indexed) {
        visitIdentifiers(file);

        indexed = true;
      }

      const symbol = checker.getSymbolAtLocation(name);

      return !symbol || !references.get(symbol)?.some((use) => use !== name && !isWriteTarget(use));
    }

    function passedUp(expression: ts.YieldExpression): string | undefined {
      let value: ts.Node = expression;

      while (ts.isParenthesizedExpression(value.parent)) value = value.parent;

      if (ts.isExpressionStatement(value.parent) || ts.isVoidExpression(value.parent))
        return 'passed up by yield* as a statement, which drops the failure that it returns';

      if (ts.isVariableDeclaration(value.parent) && ts.isIdentifier(value.parent.name) && unread(value.parent.name))
        return 'passed up by yield* into a variable that no code reads, which drops the failure that it returns';

      return undefined;
    }

    function variable(name: ts.Identifier, seen: Set<ts.Node>): string | undefined {
      if (!indexed) {
        visitIdentifiers(file);

        indexed = true;
      }

      const symbol = checker.getSymbolAtLocation(name);
      const uses = (symbol && references.get(symbol)?.filter((use) => use !== name && !isWriteTarget(use))) ?? [];

      if (uses.length === 0) {
        const statement = ts.findAncestor(name, ts.isVariableStatement);

        const exported =
          statement?.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;

        return exported
          ? 'exported, and the check does not follow a value into other files'
          : 'assigned and never used';
      }

      const reasons = uses.map((use) => lost(use, seen));

      if (reasons.includes(undefined)) return undefined;

      return `assigned to ${name.text}, which is ${reasons[0]}`;
    }

    function lost(node: ts.Expression, seen: Set<ts.Node>): string | undefined {
      if (seen.has(node)) return 'in a cycle';

      seen.add(node);

      let child: ts.Node = node;
      let parent = node.parent;

      while (passesThrough(child, parent)) {
        child = parent;

        parent = parent.parent;
      }

      if (ts.isYieldExpression(parent)) {
        if (!parent.asteriskToken) return 'yielded without *, so it never runs';

        if (!isStream(checker.getTypeAtLocation(child))) return undefined;

        return passedUp(parent);
      }

      if (ts.isAwaitExpression(parent)) {
        if (isFallible(checker.getTypeAtLocation(child))) return 'awaited, and await does not run a generator';

        return lost(parent, seen);
      }

      if (ts.isExpressionStatement(parent)) return 'dropped as a statement';

      if (ts.isVoidExpression(parent)) return 'dropped by void';

      if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.CommaToken)
        return parent.right === child ? lost(parent, seen) : 'dropped by a comma';

      if (ts.isReturnStatement(parent)) {
        const fn = ts.findAncestor(parent, ts.isFunctionLike);

        return fn ? returned(fn) : undefined;
      }

      if (ts.isArrowFunction(parent) && parent.body === child) return returned(parent);

      if (ts.isVariableDeclaration(parent) && parent.initializer === child) {
        if (ts.isIdentifier(parent.name)) return variable(parent.name, seen);

        return 'destructured, so it never runs';
      }

      if (
        ts.isBinaryExpression(parent) &&
        parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        parent.right === child
      ) {
        if (ts.isIdentifier(parent.left)) return variable(parent.left, seen);

        return isFallible(checker.getTypeAtLocation(parent.left))
          ? undefined
          : 'stored in a field that is not fallible';
      }

      if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression !== child) {
        const index = parent.arguments?.indexOf(child as ts.Expression) ?? -1;
        const parameter = index < 0 ? undefined : parameterOf(parent, index);

        if (parameter && (isFallible(parameter) || fallibleArray(declaredParameter(parent, index)))) return undefined;

        return `passed to a parameter of type ${parameter ? checker.typeToString(parameter) : 'unknown'}, which does not run it`;
      }

      if (ts.isPropertyAccessExpression(parent) && ['next', 'return', 'throw'].includes(parent.name.text))
        return undefined;

      if (
        (ts.isPropertyAssignment(parent) || ts.isShorthandPropertyAssignment(parent)) &&
        isFallible(checker.getContextualType(child as ts.Expression) ?? checker.getAnyType())
      )
        return undefined;

      if (ts.isSpreadElement(parent)) {
        if (!isFallible(checker.getTypeAtLocation(child)) && ts.isArrayLiteralExpression(parent.parent))
          return lost(parent.parent, seen);

        return 'spread, which iterates its failures and drops its value';
      }

      if (ts.isForOfStatement(parent) && isFallible(checker.getTypeAtLocation(child)))
        return fileInScope ? undefined : 'read by a for loop, which drops the failure that it returns';

      if (ts.isForOfStatement(parent)) {
        const [element] = ts.isVariableDeclarationList(parent.initializer) ? parent.initializer.declarations : [];

        return element && ts.isIdentifier(element.name)
          ? variable(element.name, seen)
          : 'iterated by for..of, which drops its value';
      }

      if (ts.isPropertyDeclaration(parent) && parent.type && isFallible(checker.getTypeFromTypeNode(parent.type)))
        return undefined;

      if (ts.isTemplateSpan(parent)) return 'turned into text by a template';

      if (ts.isArrayLiteralExpression(parent)) return lost(parent, seen);

      if (ts.isPropertyAssignment(parent) || ts.isShorthandPropertyAssignment(parent))
        return 'stored in a property that is not fallible';

      return `used as ${ts.SyntaxKind[parent.kind]}, which does not run it`;
    }

    const returnsFallible = (node: ts.Expression): boolean => {
      const signatures = checker.getTypeAtLocation(node).getCallSignatures();

      return signatures.length > 0 && signatures.every((signature) => isFallible(signature.getReturnType()));
    };

    function droppedByCaller(node: ts.Expression): string | undefined {
      const target = checker.getContextualType(node);
      const returns = target?.getCallSignatures().map((signature) => signature.getReturnType()) ?? [];
      const [first] = returns;

      if (
        !first ||
        returns.some(
          (type) =>
            carries(type) || hasTypeParameter(type) || (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0,
        )
      )
        return undefined;

      return `passed as a function to a caller that takes ${checker.typeToString(first)}, so it never runs`;
    }

    const hits: Hit[] = [];
    const calls: string[] = [];
    const checksAwaits = fileInScope && !isHelperFile(file.fileName);
    let fileLines: string[] | undefined;

    const report = (node: ts.Node, kind: Hit['kind'], message: string): void => {
      const { line, character } = file.getLineAndCharacterOfPosition(node.getStart(file));

      hits.push({ kind, file: file.fileName, line: line + 1, column: character + 1, message });
    };

    const d1Marked = (node: ts.Node): boolean => {
      const statement = ts.findAncestor(
        node,
        (at) =>
          ts.isSourceFile(at.parent) ||
          ts.isBlock(at.parent) ||
          ts.isModuleBlock(at.parent) ||
          ts.isCaseOrDefaultClause(at.parent),
      );

      if (!statement) return false;

      const { line } = file.getLineAndCharacterOfPosition(statement.getStart(file));

      if (line <= 0) return false;

      fileLines ??= file.text.split('\n');

      return D1_MARKER.test(fileLines[line - 1] ?? '');
    };

    const visit = (node: ts.Node): void => {
      if (isTypeOnlySubtree(node)) return;

      if (ts.isCallExpression(node) && carries(checker.getTypeAtLocation(node))) {
        const { line, character } = file.getLineAndCharacterOfPosition(node.getStart(file));

        calls.push(`${file.fileName}:${line}:${character}`);

        const callee = checker.getResolvedSignature(node)?.getDeclaration()?.getSourceFile().fileName;
        const reason = fileInScope || (callee !== undefined && inScope(callee)) ? lost(node, new Set()) : undefined;

        if (reason) {
          const name = node.expression.getText(file).replace(/\s+/g, ' ').slice(0, 60);

          report(node, 'drop', `the fallible call ${name}(...) is ${reason}. Run it with \`yield*\`.`);
        }
      }

      if (isValueReference(node)) {
        const declaration = fileInScope
          ? undefined
          : checker.getSymbolAtLocation(node)?.valueDeclaration?.getSourceFile().fileName;

        if ((fileInScope || (declaration !== undefined && inScope(declaration))) && returnsFallible(node)) {
          const reason = droppedByCaller(node);

          if (reason)
            report(
              node,
              'drop',
              `the fallible function ${node.getText(file)} is ${reason}. Call it with \`yield*\`, or pass it to \`each\`.`,
            );
        }
      }

      if (fileInScope && ts.isForOfStatement(node) && isFallible(checker.getTypeAtLocation(node.expression))) {
        report(
          node.expression,
          'drop',
          `the stream is read by a for loop, which drops the failure that it returns. ${READ_STREAM}`,
        );
      }

      if (fileInScope && ts.isYieldExpression(node) && node.asteriskToken && node.expression) {
        let operand = node.expression;

        while (ts.isParenthesizedExpression(operand)) operand = operand.expression;

        const reason =
          !ts.isCallExpression(operand) && isStream(checker.getTypeAtLocation(operand)) ? passedUp(node) : undefined;

        if (reason) report(operand, 'drop', `the stream is ${reason}. ${READ_STREAM}`);
      }

      if (checksAwaits && (ts.isAwaitExpression(node) || (ts.isForOfStatement(node) && node.awaitModifier))) {
        const reason = outside(node);

        if (reason && !d1Marked(node)) report(node, 'outside', reason);
      }

      ts.forEachChild(node, visit);
    };

    visit(file);

    return { hits, calls };
  };
}
