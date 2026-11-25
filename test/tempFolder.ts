import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export default function setup(): () => void {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'ontology-test-')));

  process.env.TMPDIR = folder;

  return () => rmSync(folder, { recursive: true, force: true });
}
