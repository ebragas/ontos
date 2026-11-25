const FALLIBLE_TYPE = /Fallible$/;

const typeName = (node) =>
  node?.type === 'TSTypeReference'
    ? node.typeName.type === 'Identifier'
      ? node.typeName.name
      : node.typeName.right?.name
    : undefined;

function isFallibleType(node) {
  const name = typeName(node);

  if (name === undefined) return false;

  if (FALLIBLE_TYPE.test(name)) return true;

  const params = node.typeArguments?.params ?? node.typeParameters?.params ?? [];

  return (name === 'Generator' || name === 'AsyncGenerator') && params[2]?.type === 'TSNeverKeyword';
}

const isGenerator = (node) =>
  (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') && node.generator;

function enclosingFunction(node) {
  for (let at = node.parent; at; at = at.parent) {
    if (at.type === 'FunctionDeclaration' || at.type === 'FunctionExpression' || at.type === 'ArrowFunctionExpression')
      return at;
  }

  return undefined;
}

const propertyName = (node) =>
  node.type !== 'MemberExpression'
    ? undefined
    : node.computed
      ? typeof node.property.value === 'string'
        ? node.property.value
        : undefined
      : node.property.name;

const isMember = (callee, object, property) =>
  propertyName(callee) === property &&
  (object === undefined || (callee.object.type === 'Identifier' && callee.object.name === object));

const CATCH_ALL_EVENTS = new Set(['uncaughtException', 'unhandledRejection']);

const noThrow = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      throw: 'Refuse with `return yield failure`. Mark a defect with `invariant(condition, message)`.',
      reject: 'A Promise that rejects is a throw. Make the function a generator, and yield its failure.',
      orThrow: 'orThrow turns a failure into a throw. A converted file passes the failure up with `yield*`.',
      exit: 'Only the border ends the process. Pass the failure up with `yield*`.',
      generatorThrow: 'gen.throw raises a throw inside a generator. Pass a failure with `return yield failure`.',
    },
  },
  create(context) {
    return {
      ThrowStatement: (node) => context.report({ node, messageId: 'throw' }),
      ImportSpecifier(node) {
        if ((node.imported.name ?? node.imported.value) === 'orThrow') context.report({ node, messageId: 'orThrow' });
      },
      CallExpression(node) {
        if (isMember(node.callee, undefined, 'reject')) context.report({ node, messageId: 'reject' });

        if (node.callee.type === 'Identifier' && node.callee.name === 'orThrow')
          context.report({ node, messageId: 'orThrow' });

        if (isMember(node.callee, 'process', 'exit')) context.report({ node, messageId: 'exit' });

        if (isMember(node.callee, undefined, 'throw')) context.report({ node, messageId: 'generatorThrow' });
      },
      NewExpression(node) {
        const [executor] = node.arguments;

        const rejects =
          node.callee.type === 'Identifier' &&
          node.callee.name === 'Promise' &&
          executor &&
          'params' in executor &&
          executor.params.length > 1;

        if (rejects) context.report({ node: executor.params[1], messageId: 'reject' });
      },
    };
  },
};

const noCatch = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      catch:
        'Run a library call that throws with `caught`, and an outside call that can fail with `attempt`. Only `outcome` at a border catches each throw.',
    },
  },
  create(context) {
    return {
      CatchClause: (node) => context.report({ node, messageId: 'catch' }),
      CallExpression(node) {
        const listens =
          ['on', 'once', 'addListener', 'prependListener'].some((name) => isMember(node.callee, 'process', name)) &&
          CATCH_ALL_EVENTS.has(node.arguments[0]?.value);

        const catches =
          isMember(node.callee, undefined, 'catch') ||
          (isMember(node.callee, undefined, 'then') && node.arguments.length > 1) ||
          listens;

        if (catches) context.report({ node, messageId: 'catch' });
      },
    };
  },
};

const returnYield = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      returnType:
        'Give each generator its return type, such as `AsyncFallible<T>` or `AsyncGenerator<Row>`, so the rules know a fallible function.',
      returnYield: 'A fallible function fails with `return yield failure`, so no code runs after its failure.',
      aliasName: 'Give a fallible type a name that ends in Fallible, so the rules know a fallible function.',
    },
  },
  create(context) {
    const checkReturnType = (node) => {
      if (isGenerator(node) && !node.returnType) context.report({ node, messageId: 'returnType' });
    };

    return {
      FunctionDeclaration: checkReturnType,
      FunctionExpression: checkReturnType,
      TSTypeAliasDeclaration(node) {
        if (isFallibleType(node.typeAnnotation) && !FALLIBLE_TYPE.test(node.id.name))
          context.report({ node: node.id, messageId: 'aliasName' });
      },
      ImportSpecifier(node) {
        const imported = node.imported.name ?? node.imported.value;

        if (FALLIBLE_TYPE.test(imported) && !FALLIBLE_TYPE.test(node.local.name))
          context.report({ node, messageId: 'aliasName' });
      },
      YieldExpression(node) {
        if (node.delegate) return;

        const fn = enclosingFunction(node);

        if (!fn || !isFallibleType(fn.returnType?.typeAnnotation)) return;

        if (node.parent.type !== 'ReturnStatement') context.report({ node, messageId: 'returnYield' });
      },
    };
  },
};

function inFinally(node) {
  for (let child = node, at = node.parent; at; child = at, at = at.parent) {
    if (at.type === 'FunctionDeclaration' || at.type === 'FunctionExpression' || at.type === 'ArrowFunctionExpression')
      return false;

    if (at.type === 'TryStatement' && at.finalizer === child) return true;
  }

  return false;
}

const noYieldInFinally = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      finally:
        'A finally block runs after a failure, so a failure that it yields is lost, and settle throws a defect. Clean up with no fallible call.',
    },
  },
  create(context) {
    return {
      YieldExpression(node) {
        if (inFinally(node)) context.report({ node, messageId: 'finally' });
      },
    };
  },
};

const BRIDGE = /(^|\/)dbBridge(\/index\.ts)?$/;

const noBridgeImport = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      bridge:
        'A converted file takes the fallible `Db` of `db/index.ts`. dbBridge is only for a module that is not converted yet.',
    },
  },
  create(context) {
    const check = (node) => {
      if (node.source?.type === 'Literal' && typeof node.source.value === 'string' && BRIDGE.test(node.source.value))
        context.report({ node, messageId: 'bridge' });
    };

    return {
      ImportDeclaration: check,
      ExportNamedDeclaration: check,
      ExportAllDeclaration: check,
      ImportExpression: check,
    };
  },
};

function generatorOf(context, node, name) {
  for (let scope = context.sourceCode.getScope(node); scope; scope = scope.upper) {
    const variable = scope.set.get(name);

    if (!variable) continue;

    for (const def of variable.defs) {
      if (isGenerator(def.node)) return def.node;

      if (def.node.type === 'VariableDeclarator' && def.node.init && isGenerator(def.node.init)) return def.node.init;
    }

    return undefined;
  }

  return undefined;
}

const noDroppedCall = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      dropped:
        'A call of the generator {{name}} does nothing until it runs. Pass its failure up with `yield* {{name}}(...)`.',
    },
  },
  create(context) {
    return {
      ExpressionStatement(node) {
        const call = node.expression.type === 'AwaitExpression' ? node.expression.argument : node.expression;

        if (call.type !== 'CallExpression' || call.callee.type !== 'Identifier') return;

        if (generatorOf(context, node, call.callee.name))
          context.report({ node, messageId: 'dropped', data: { name: call.callee.name } });
      },
    };
  },
};

export default {
  meta: { name: 'fallible' },
  rules: {
    'no-throw': noThrow,
    'no-catch': noCatch,
    'return-yield': returnYield,
    'no-dropped-call': noDroppedCall,
    'no-yield-in-finally': noYieldInFinally,
    'no-bridge-import': noBridgeImport,
  },
};
