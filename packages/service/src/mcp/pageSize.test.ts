import { describe, expect, it } from 'vitest';
import { pageSizeOf } from './pageSize.ts';

describe('service/ontology-mcp#tools: the page size clamp', () => {
  it('service/ontology-mcp#tools: gives 50 for no pageSize and for a null pageSize', () => {
    expect(pageSizeOf(undefined, 200)).toBe(50);
    expect(pageSizeOf(null, 200)).toBe(50);
    expect(pageSizeOf(null, 100)).toBe(50);
  });

  it('service/ontology-mcp#tools: keeps a pageSize up to the maximum, and reduces a larger one to 200, or 100 for get_edit_history', () => {
    expect(pageSizeOf(1, 200)).toBe(1);
    expect(pageSizeOf(200, 200)).toBe(200);
    expect(pageSizeOf(201, 200)).toBe(200);
    expect(pageSizeOf(5000, 200)).toBe(200);
    expect(pageSizeOf(100, 100)).toBe(100);
    expect(pageSizeOf(101, 100)).toBe(100);
  });

  it('service/ontology-mcp#tools: passes each other value through unchanged, so the engine refuses it', () => {
    expect(pageSizeOf(0, 200)).toBe(0);
    expect(pageSizeOf(-1, 200)).toBe(-1);
    expect(pageSizeOf(1.5, 200)).toBe(1.5);
    expect(pageSizeOf('ten', 200)).toBe('ten');
    expect(pageSizeOf('50', 200)).toBe('50');
  });
});
