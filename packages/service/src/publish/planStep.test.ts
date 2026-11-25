import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const folder = new URL('./', import.meta.url);

const files = readdirSync(folder).filter(
  (name) => name.endsWith('.ts') && !/\.(test|test-utils|fixture)\.ts$/.test(name),
);

function callers(name: string): string[] {
  const call = new RegExp(`(?<!function\\*? )\\b${name}\\(`);

  return files.filter((file) => call.test(readFileSync(new URL(file, folder), 'utf8'))).sort();
}

describe('service/code-layout#seams: planStep is the one plan of 1 step', () => {
  it('service/code-layout#seams: only planStep runs the schema migration check and the column limit check of a plan', () => {
    expect(callers('useSchemaMigrations')).toEqual(['upgrade.ts']);
    expect(callers('checkColumnLimit')).toEqual(['upgrade.ts']);
  });

  it('service/code-layout#seams: the check of publish and the upgrade chain both call planStep', () => {
    expect(callers('planStep')).toEqual(['publishOntology.ts', 'upgrade.ts']);
  });

  it('service/code-layout#seams: the check of publish and each step of the chain both call checkStoredRules', () => {
    expect(callers('checkStoredRules')).toEqual(['publishOntology.ts', 'upgrade.ts']);
  });
});
