export default async function fillHeap(): Promise<string> {
  const kept: unknown[] = [];

  for (;;) kept.push(new Array(1e5).fill({ kept: kept.length }));
}
