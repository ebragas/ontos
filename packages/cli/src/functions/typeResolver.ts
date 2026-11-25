import type { DiscoveredDataType, DiscoveredFunction, PublishRequest } from '@ericbragas/ontos-service/publish';
import { createHash } from 'node:crypto';
import { relative, sep } from 'node:path';
import type ts from 'typescript';
import { CliError } from '../cliError.ts';
import type { Fallible } from '../fallible.ts';

type DataType = DiscoveredDataType;

type Location = {
  readonly startLineNumber: number;
  readonly endLineNumber: number;
  readonly startColumn: number;
  readonly endColumn: number;
};

export type CliDiscoveredInput = DiscoveredFunction['inputs'][number] & { readonly constraints: readonly unknown[] };

export interface CliDiscoveredFunction extends DiscoveredFunction {
  readonly locator: {
    readonly type: 'typescript';
    readonly typescript: { readonly functionName: string; readonly filePath: string; readonly codeLocation: Location };
  };
  readonly inputs: readonly CliDiscoveredInput[];
}

export const tag = (type: string, body: unknown = {}): DataType => ({ type, [type]: body });

const PRIMITIVES: Record<string, string> = {
  Integer: 'integer',
  Long: 'long',
  Decimal: 'decimal',
  Float: 'float',
  Double: 'double',
  DateISOString: 'date',
  TimestampISOString: 'timestamp',
};

const OBJECT_EDITS = new Set(['CreateObject', 'UpdateObject', 'DeleteObject']);
const LINK_EDITS = new Set(['AddLink', 'RemoveLink']);

export function location(node: ts.Node): Location {
  const file = node.getSourceFile();
  const start = file.getLineAndCharacterOfPosition(node.getStart(file));
  const end = file.getLineAndCharacterOfPosition(node.getEnd());

  return {
    startLineNumber: start.line + 1,
    endLineNumber: end.line + 1,
    startColumn: start.character,
    endColumn: end.character,
  };
}

function linkTypeApiName(ir: PublishRequest['ir'], objectType: string, side: string): string | undefined {
  const camel = (id: string) => id.replace(/-(.?)/g, (_match, next: string) => next.toUpperCase());

  for (const [id, block] of Object.entries(ir.ontology.linkTypes)) {
    const { definition } = block.linkType;

    const sides: [string, { apiName?: string | null | undefined }][] =
      definition.type === 'oneToMany'
        ? [
            [definition.oneToMany.objectTypeRidOneSide, definition.oneToMany.oneToManyLinkMetadata],
            [definition.oneToMany.objectTypeRidManySide, definition.oneToMany.manyToOneLinkMetadata],
          ]
        : definition.type === 'manyToMany'
          ? [
              [definition.manyToMany.objectTypeRidA, definition.manyToMany.objectTypeAToBLinkMetadata],
              [definition.manyToMany.objectTypeRidB, definition.manyToMany.objectTypeBToALinkMetadata],
            ]
          : [];

    if (sides.some(([owner, metadata]) => owner === objectType && metadata.apiName === side)) return camel(id);
  }

  return undefined;
}

export function lfText(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

export class TypeResolver {
  readonly checker: ts.TypeChecker;
  private readonly ts: typeof ts;
  private readonly projectFolder: string;
  private readonly ir: PublishRequest['ir'];
  customTypes: Record<string, unknown> = {};
  private readonly reading = new Set<string>();

  constructor(tsModule: typeof ts, program: ts.Program, projectFolder: string, ir: PublishRequest['ir']) {
    this.ts = tsModule;
    this.checker = program.getTypeChecker();
    this.projectFolder = projectFolder;
    this.ir = ir;
  }

  relativePath(file: ts.SourceFile): string {
    return relative(this.projectFolder, file.fileName).split(sep).join('/');
  }

  private *apiNameOf(type: ts.Type, owner: string): Fallible<string, CliError> {
    const property = type.getProperty('apiName');
    const value = property ? this.checker.getTypeOfSymbol(property) : undefined;

    if (!value?.isStringLiteral())
      return yield new CliError(
        `${owner}: ${this.checker.typeToString(type)} has no literal apiName. Import the type from the Ontology SDK.`,
      );

    return value.value;
  }

  *unsupported(type: ts.Type, owner: string): Fallible<never, CliError> {
    return yield new CliError(`${owner}: "${this.checker.typeToString(type)}" is not a supported type.`);
  }

  private *dataType(type: ts.Type, owner: string): Fallible<DataType, CliError> {
    const alias = type.aliasSymbol?.getName();

    if (alias && PRIMITIVES[alias]) return tag(PRIMITIVES[alias]);

    if (alias === 'Instance' && type.aliasTypeArguments?.[0])
      return tag('object', { objectTypeId: yield* this.apiNameOf(type.aliasTypeArguments[0], owner) });

    const symbol = type.getSymbol()?.getName() ?? alias;

    if (symbol === 'ObjectSet' && (type.aliasTypeArguments?.[0] ?? this.typeArguments(type)[0])) {
      return tag('objectSet', {
        objectTypeId: yield* this.apiNameOf(
          (type.aliasTypeArguments?.[0] ?? this.typeArguments(type)[0]) as ts.Type,
          owner,
        ),
      });
    }

    if (type.flags & this.ts.TypeFlags.StringLike) return tag('string');

    if (type.flags & this.ts.TypeFlags.BooleanLike) return tag('boolean');

    if (type.flags & this.ts.TypeFlags.NumberLike) return tag('double');

    if (this.checker.isArrayType(type)) {
      const [element] = this.typeArguments(type);

      if (!element) return yield* this.unsupported(type, owner);

      return tag('list', {
        elementsType: this.isEdit(element) ? tag('ontologyEdit') : yield* this.dataType(element, owner),
      });
    }

    const declaration = type.getSymbol()?.getDeclarations()?.[0];

    if (declaration && this.ts.isInterfaceDeclaration(declaration) && !declaration.getSourceFile().isDeclarationFile)
      return yield* this.customType(type, declaration, owner);

    return yield* this.unsupported(type, owner);
  }

  typeArguments(type: ts.Type): readonly ts.Type[] {
    return (type.flags & this.ts.TypeFlags.Object) !== 0 &&
      ((type as ts.ObjectType).objectFlags & this.ts.ObjectFlags.Reference) !== 0
      ? this.checker.getTypeArguments(type as ts.TypeReference)
      : [];
  }

  *member(
    type: ts.Type,
    optional: boolean,
    owner: string,
    node?: ts.TypeNode,
  ): Fallible<{ dataType: DataType; required: boolean; allowedValues?: string[] }, CliError> {
    const members = type.isUnion()
      ? type.types.filter((member) => (member.flags & this.ts.TypeFlags.Undefined) === 0)
      : [type];

    const isOptional = optional || members.length < (type.isUnion() ? type.types.length : 1);
    const inner = members.length === 1 && members[0] ? members[0] : this.checker.getNonNullableType(type);
    const allowedValues = node && this.stringLiterals(inner, node);

    const dataType = !allowedValues
      ? yield* this.dataType(inner, owner)
      : this.checker.isArrayType(inner)
        ? tag('list', { elementsType: tag('string') })
        : tag('string');

    const member = isOptional
      ? { dataType: tag('optionalType', { wrappedType: dataType }), required: false }
      : { dataType, required: true };

    return allowedValues ? { ...member, allowedValues } : member;
  }

  private stringLiterals(type: ts.Type, node: ts.TypeNode): string[] | undefined {
    const element = this.checker.isArrayType(type) ? this.typeArguments(type)[0] : type;
    const members = element?.isUnion() ? element.types : element ? [element] : [];

    if (
      members.length === 0 ||
      !members.every(
        (member): member is ts.StringLiteralType =>
          member.isStringLiteral() && (member.flags & this.ts.TypeFlags.EnumLiteral) === 0,
      )
    )
      return undefined;

    const order = this.literalsOf(node, new Set());
    const rank = (value: string) => (order.includes(value) ? order.indexOf(value) : order.length);

    return members.map((member) => member.value).sort((a, b) => rank(a) - rank(b));
  }

  private literalsOf(node: ts.Node, seen: Set<ts.Node>): string[] {
    if (seen.has(node)) return [];

    seen.add(node);

    if (this.ts.isLiteralTypeNode(node) && this.ts.isStringLiteral(node.literal)) return [node.literal.text];

    const found: string[] = [];

    if (this.ts.isTypeReferenceNode(node)) {
      const symbol = this.checker.getSymbolAtLocation(node.typeName);

      const target =
        symbol && symbol.flags & this.ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(symbol) : symbol;

      const alias = target?.getDeclarations()?.find(this.ts.isTypeAliasDeclaration);

      if (alias) found.push(...this.literalsOf(alias.type, seen));
    }

    node.forEachChild((child) => {
      found.push(...this.literalsOf(child, seen));
    });

    return found;
  }

  private *customType(
    type: ts.Type,
    declaration: ts.InterfaceDeclaration,
    owner: string,
  ): Fallible<DataType, CliError> {
    const filePath = this.relativePath(declaration.getSourceFile());
    const interfaceName = declaration.name.text;
    const hash = createHash('sha1').update(`${filePath}#${interfaceName}`).digest('hex');
    const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${((parseInt(hash.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${hash.slice(18, 20)}-${hash.slice(20, 32)}`;

    if (this.reading.has(id))
      return yield new CliError(
        `${owner}: the interface ${interfaceName} of ${filePath} refers to itself. A Function input or output cannot hold a recursive type.`,
      );

    if (!(id in this.customTypes)) {
      this.reading.add(id);

      const fields: Record<string, DataType> = {};
      const fieldMetadata: Record<string, { required: boolean }> = {};

      for (const property of type.getProperties()) {
        const optional = (property.flags & this.ts.SymbolFlags.Optional) !== 0;

        const field = yield* this.member(
          this.checker.getTypeOfSymbol(property),
          optional,
          `${owner}, field ${property.getName()}`,
        );

        fields[property.getName()] = field.dataType;

        fieldMetadata[property.getName()] = { required: field.required };
      }

      this.customTypes[id] = {
        id,
        locator: { interfaceName, filePath, codeLocation: location(declaration) },
        fields,
        fieldMetadata,
      };

      this.reading.delete(id);
    }

    return tag('functionCustomType', id);
  }

  refusedOutput(type: ts.Type): boolean {
    if (!type.isUnion()) return false;

    if (type.types.some((member) => (member.flags & this.ts.TypeFlags.Null) !== 0)) return true;

    return type.types.some((member) => {
      const [element] = this.checker.isArrayType(member) ? this.typeArguments(member) : [];

      return element !== undefined && this.isEdit(element);
    });
  }

  private editMembers(type: ts.Type): ts.Type[] {
    return type.isUnion() ? type.types : [type];
  }

  isEdit(type: ts.Type): boolean {
    const members = this.editMembers(type);

    return (
      members.length > 0 &&
      members.every((member) => {
        const name = member.getSymbol()?.getName() ?? '';

        return OBJECT_EDITS.has(name) || LINK_EDITS.has(name);
      })
    );
  }

  *provenance(
    edit: ts.Type | undefined,
    owner: string,
  ): Fallible<NonNullable<DiscoveredFunction['ontologyProvenance']>, CliError> {
    const editedLinks: Record<string, object> = {};
    const editedObjects: Record<string, object> = {};

    for (const member of edit ? this.editMembers(edit) : []) {
      const name = member.getSymbol()?.getName() ?? '';
      const [target, side] = this.typeArguments(member);

      if (!target) continue;

      if (OBJECT_EDITS.has(name)) editedObjects[yield* this.apiNameOf(target, owner)] = {};

      if (LINK_EDITS.has(name)) {
        const objectType = yield* this.apiNameOf(target, owner);
        const sideName = side?.isStringLiteral() ? side.value : undefined;
        const linkType = sideName === undefined ? undefined : linkTypeApiName(this.ir, objectType, sideName);

        if (!linkType)
          return yield new CliError(
            `${owner}: the Edits type names the Link ${String(sideName)} of ${objectType}, which the Ontology-as-code does not define.`,
          );

        editedLinks[linkType] = {};
      }
    }

    return { editedLinks, editedObjects, editedInterfaces: {} };
  }
}
