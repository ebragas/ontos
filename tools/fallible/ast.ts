import ts from 'typescript';

export const NO_RETURNED_VALUE =
  ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Never | ts.TypeFlags.Any | ts.TypeFlags.Unknown;

export const SIMPLE_NON_OBJECT =
  ts.TypeFlags.Any |
  ts.TypeFlags.Unknown |
  ts.TypeFlags.String |
  ts.TypeFlags.Number |
  ts.TypeFlags.Boolean |
  ts.TypeFlags.BigInt |
  ts.TypeFlags.StringLiteral |
  ts.TypeFlags.NumberLiteral |
  ts.TypeFlags.BooleanLiteral |
  ts.TypeFlags.BigIntLiteral |
  ts.TypeFlags.Void |
  ts.TypeFlags.Undefined |
  ts.TypeFlags.Null |
  ts.TypeFlags.Never |
  ts.TypeFlags.ESSymbol |
  ts.TypeFlags.UniqueESSymbol;

export function isTypeOnlySubtree(node: ts.Node): boolean {
  return (
    ts.isTypeNode(node) ||
    ts.isImportDeclaration(node) ||
    ts.isExportDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isTypeParameterDeclaration(node)
  );
}

export function isValueReference(node: ts.Node): node is ts.Identifier | ts.PropertyAccessExpression {
  if (!ts.isIdentifier(node) && !ts.isPropertyAccessExpression(node)) return false;

  const parent = node.parent;

  if (!parent || isCallee(node)) return false;

  if (ts.isPropertyAccessExpression(parent)) return false;

  if (ts.isElementAccessExpression(parent) && parent.expression === node) return false;

  if (ts.isExpressionStatement(parent)) return false;

  if (
    ts.isPrefixUnaryExpression(parent) ||
    ts.isPostfixUnaryExpression(parent) ||
    ts.isTypeOfExpression(parent) ||
    ts.isDeleteExpression(parent) ||
    ts.isVoidExpression(parent)
  )
    return false;

  if (ts.isThrowStatement(parent)) return false;

  if (
    ts.isTemplateSpan(parent) &&
    !(ts.isTemplateExpression(parent.parent) && ts.isTaggedTemplateExpression(parent.parent.parent))
  )
    return false;

  if (
    (ts.isIfStatement(parent) ||
      ts.isWhileStatement(parent) ||
      ts.isDoStatement(parent) ||
      ts.isSwitchStatement(parent) ||
      ts.isForOfStatement(parent) ||
      ts.isForInStatement(parent)) &&
    parent.expression === node
  ) {
    return false;
  }

  if (ts.isBinaryExpression(parent)) {
    const kind = parent.operatorToken.kind;

    if (
      kind === ts.SyntaxKind.EqualsToken ||
      kind === ts.SyntaxKind.CommaToken ||
      kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
      kind === ts.SyntaxKind.BarBarEqualsToken ||
      kind === ts.SyntaxKind.QuestionQuestionEqualsToken
    ) {
      if (parent.left === node) return false;
    } else if (
      kind !== ts.SyntaxKind.AmpersandAmpersandToken &&
      kind !== ts.SyntaxKind.BarBarToken &&
      kind !== ts.SyntaxKind.QuestionQuestionToken
    ) {
      return false;
    }
  }

  if (ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) return false;

  if (
    (ts.isVariableDeclaration(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isParameter(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent) ||
      ts.isEnumDeclaration(parent) ||
      ts.isEnumMember(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isBindingElement(parent)) &&
    parent.name === node
  ) {
    return false;
  }

  return true;
}

export function passesThrough(child: ts.Node, parent: ts.Node): boolean {
  if (
    ts.isParenthesizedExpression(parent) ||
    ts.isAsExpression(parent) ||
    ts.isSatisfiesExpression(parent) ||
    ts.isNonNullExpression(parent) ||
    ts.isTypeAssertionExpression(parent)
  )
    return true;

  if (ts.isConditionalExpression(parent)) return parent.whenTrue === child || parent.whenFalse === child;

  if (!ts.isBinaryExpression(parent) || parent.right !== child) return false;

  const kind = parent.operatorToken.kind;

  return (
    kind === ts.SyntaxKind.QuestionQuestionToken ||
    kind === ts.SyntaxKind.BarBarToken ||
    kind === ts.SyntaxKind.AmpersandAmpersandToken
  );
}

function isCallee(node: ts.Node): boolean {
  return (ts.isCallExpression(node.parent) || ts.isNewExpression(node.parent)) && node.parent.expression === node;
}

export function isWriteTarget(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;

  return (
    ts.isBinaryExpression(parent) &&
    parent.left === identifier &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
  );
}
