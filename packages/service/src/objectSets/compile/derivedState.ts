import type { CompiledDerivedProperty, CompiledObjectType, DerivedNode } from '../../ontology/index.ts';
import { leavesOf, type SelectionNode } from './derivedSql.ts';
import type { ReturnReason } from './row.ts';

type Origin =
  | { readonly form: 'objectType'; readonly property: CompiledDerivedProperty }
  | { readonly form: 'request'; readonly position: number };

type DerivedReason = ReturnReason | 'query';

interface DerivedEntry {
  readonly objectType: CompiledObjectType;
  readonly origin: Origin;
  readonly node: DerivedNode;
}

export interface DerivedUse {
  readonly objectType: CompiledObjectType;
  readonly origin: Origin;
  readonly reason: DerivedReason;
  readonly hops: number;
  readonly operation: SelectionNode['operation']['kind'] | 'property' | 'expression';
}

export interface DerivedRead {
  readonly values: readonly DerivedUse[];
  readonly objects?: number;
  readonly sqlMs: number;
}

export class DerivedUses {
  private readonly reasons = new Map<DerivedEntry, DerivedReason>();

  get size(): number {
    return this.reasons.size;
  }

  hasRequest(): boolean {
    for (const entry of this.reasons.keys()) if (entry.origin.form === 'request') return true;

    return false;
  }

  computed(entry: DerivedEntry): void {
    if (!this.reasons.has(entry)) this.reasons.set(entry, 'query');
  }

  returned(entry: DerivedEntry, reason: ReturnReason): void {
    this.reasons.set(entry, reason);
  }

  values(): DerivedUse[] {
    return [...this.reasons].map(([{ objectType, origin, node }, reason]) => {
      const leaves = leavesOf([node]);
      const hops = leaves.reduce((sum, leaf) => sum + (leaf.kind === 'selection' ? leaf.path.hops : 0), 0);

      const operation =
        node.kind === 'selection' ? node.operation.kind : node.kind === 'property' ? 'property' : 'expression';

      return { objectType, origin, reason, hops, operation };
    });
  }
}

export class Names {
  private count = 0;

  next(prefix: '__r' | '__l' | '__d'): string {
    this.count += 1;

    return `${prefix}${this.count}`;
  }
}

const MAX_DEFINITIONS = 1000;

export class DefinitionBudget {
  private left: number;

  constructor(limit = MAX_DEFINITIONS) {
    this.left = limit;
  }

  static unlimited(): DefinitionBudget {
    return new DefinitionBudget(Number.POSITIVE_INFINITY);
  }

  spend(definitions: number): boolean {
    this.left -= definitions;

    return this.left >= 0;
  }
}
