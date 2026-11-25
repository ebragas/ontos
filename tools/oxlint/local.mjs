import path from 'node:path';

const src = 'packages/service/src';

const moduleBorder = {
  meta: {
    type: 'problem',
    schema: [{ type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } } }],
    messages: {
      inner: 'Import another module only through its index.ts.',
      adapter: 'A module never imports an adapter.',
      normal: 'Write the import path in normal form, with no "//", "/./", or "/../" inside it.',
      direction:
        'The {{from}} module may not import a value from {{to}}. Use import type, or change runtimeImports in oxlint.config.ts.',
    },
  },
  create(context) {
    const runtimeImports = context.options[0] ?? {};
    const root = path.resolve(context.cwd, src);
    const file = context.filename;
    const fromSrc = path.relative(root, file).split(path.sep);
    const from = fromSrc[0] !== '..' && fromSrc.length > 1 ? fromSrc[0] : 'adapter';

    function check(node, typeOnly) {
      const source = node.source?.value;

      if (typeof source !== 'string' || !source.startsWith('.')) return;

      const target = path.relative(root, path.resolve(path.dirname(file), source)).split(path.sep);

      if (target[0] === '..' || path.isAbsolute(target[0])) return;

      const normal = path.posix.normalize(source);

      if (source !== (source.startsWith('./') ? `./${normal}` : normal))
        return context.report({ node, messageId: 'normal' });

      const [to, ...rest] = target;

      if (rest.length === 0) {
        if (from !== 'adapter') return context.report({ node, messageId: 'adapter' });

        return;
      }

      if (to === from) return;

      if (rest.join('/') !== 'index.ts') return context.report({ node, messageId: 'inner' });

      if (!typeOnly && !(runtimeImports[from] ?? []).includes(to)) {
        context.report({ node, messageId: 'direction', data: { from, to } });
      }
    }

    const allTypes = (specifiers, kind) => specifiers.length > 0 && specifiers.every((s) => s[kind] === 'type');

    return {
      ImportDeclaration: (node) => check(node, node.importKind === 'type' || allTypes(node.specifiers, 'importKind')),
      ExportNamedDeclaration: (node) =>
        check(node, node.exportKind === 'type' || allTypes(node.specifiers, 'exportKind')),
      ExportAllDeclaration: (node) => check(node, node.exportKind === 'type'),
      ImportExpression: (node) => check(node, false),
    };
  },
};

const isFileUrlHref = (node) =>
  node.type === 'MemberExpression' &&
  !node.computed &&
  node.property.type === 'Identifier' &&
  node.property.name === 'href' &&
  node.object.type === 'CallExpression' &&
  node.object.callee.type === 'Identifier' &&
  node.object.callee.name === 'pathToFileURL';

const staticImport = {
  meta: {
    type: 'problem',
    schema: [
      {
        type: 'object',
        properties: {
          base64Module: { type: 'boolean' },
          fileUrl: { type: 'boolean' },
          allow: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    messages: { dynamic: 'Use a static import, so the border rules can check it.' },
  },
  create(context) {
    const base64Module = context.options[0]?.base64Module === true;
    const fileUrl = context.options[0]?.fileUrl === true;
    const allow = new Set(context.options[0]?.allow ?? []);

    return {
      ImportExpression(node) {
        const { source } = node;

        if (
          base64Module &&
          source.type === 'TemplateLiteral' &&
          source.quasis[0]?.value.raw === 'data:text/javascript;base64,'
        )
          return;

        if (fileUrl && isFileUrlHref(source)) return;

        if (source.type === 'Literal' && typeof source.value === 'string' && allow.has(source.value)) return;

        context.report({ node, messageId: 'dynamic' });
      },
    };
  },
};

const noSnapshotCast = {
  meta: {
    type: 'problem',
    schema: [],
    messages: { cast: 'Only Db.snapshot makes a SnapshotDb. In a test, use the helper in src/service.test-utils.ts.' },
  },
  create(context) {
    const check = (node) => {
      const type = node.typeAnnotation;

      if (
        type.type === 'TSTypeReference' &&
        type.typeName.type === 'Identifier' &&
        type.typeName.name === 'SnapshotDb'
      ) {
        context.report({ node: type, messageId: 'cast' });
      }
    };

    return { TSAsExpression: check, TSTypeAssertion: check };
  },
};

export default {
  meta: { name: 'local' },
  rules: { 'module-border': moduleBorder, 'static-import': staticImport, 'no-snapshot-cast': noSnapshotCast },
};
