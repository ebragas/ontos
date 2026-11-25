export type OsdkSet = Readonly<Record<string, string>>;

export type SchemaMigration =
  | { readonly type: 'dropProperty'; readonly objectType: string; readonly property: string }
  | { readonly type: 'dropAllPatches'; readonly objectType: string }
  | { readonly type: 'dropLinks'; readonly linkType: string }
  | { readonly type: 'renameProperty'; readonly objectType: string; readonly source: string; readonly target: string }
  | { readonly type: 'dropEditHistory'; readonly objectType: string };

export interface SchemaMigrationsFile {
  readonly migrations: readonly SchemaMigration[];
}

export interface DiscoveredDataType {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface DiscoveredFunction {
  readonly locator: { readonly type: string; readonly typescript?: { readonly functionName: string } };
  readonly inputs: readonly {
    readonly name: string;
    readonly dataType: DiscoveredDataType;
    readonly required?: boolean;
    readonly allowedValues?: readonly string[];
    readonly description?: string;
  }[];
  readonly output:
    | { readonly type?: 'single'; readonly single: { readonly dataType: DiscoveredDataType } }
    | { readonly type: 'void'; readonly void?: Readonly<Record<string, never>> };
  readonly customTypes: Readonly<Record<string, unknown>>;
  readonly documentation?: string;
  readonly ontologyProvenance?: {
    readonly editedObjects: Readonly<Record<string, object>>;
    readonly editedLinks: Readonly<Record<string, object>>;
    readonly editedInterfaces: Readonly<Record<string, object>>;
  };
}

export interface PublishedFunctions {
  readonly discovered: readonly DiscoveredFunction[];
  readonly bundle: string;
}
