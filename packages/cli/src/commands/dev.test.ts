import { describe, expect, it } from 'vitest';
import { cli } from '../cli.test-utils.ts';

const DUMMY_DB = 'postgres://user:pass@127.0.0.1:5432/ontos';

describe('ontos dev flag validation', () => {
  it('refuses missing DATABASE_URL', async () => {
    const missing = await cli(['dev'], { env: {} });

    expect(missing.code).toBe(1);
    expect(missing.error).toEqual({ message: 'No database URL: pass --database-url <url>, or set DATABASE_URL.' });
  });

  it.each([
    ['', 'an empty string'],
    ['   ', 'an empty string'],
    ['abc', 'abc'],
    ['-1', '-1'],
    ['1.5', '1.5'],
    ['1e2', '1e2'],
    ['65536', '65536'],
    ['99999', '99999'],
  ])('refuses invalid --port %j', async (port, shown) => {
    const result = await cli(['dev', `--port=${port}`, '--database-url', DUMMY_DB]);

    expect(result.code).toBe(1);
    expect(result.error).toEqual({ message: `--port must be a whole number from 0 to 65535, not ${shown}.` });
  });

  it('refuses blank --host, empty --token, and malformed --product-rid', async () => {
    const badHost = await cli(['dev', '--host', '   ', '--database-url', DUMMY_DB]);

    expect(badHost.code).toBe(1);
    expect(badHost.error).toEqual({ message: '--host must be a non-empty hostname or IP address.' });

    const badToken = await cli(['dev', '--token', '', '--database-url', DUMMY_DB]);

    expect(badToken.code).toBe(1);
    expect(badToken.error).toEqual({ message: '--token must be a non-empty string.' });

    const badRid = await cli(['dev', '--database-url', DUMMY_DB, '--product-rid', 'bad-rid']);

    expect(badRid.code).toBe(1);
    expect(badRid.error).toEqual({ message: '--product-rid must have the form ri.ontology.main.ontology.<UUID>.' });
  });
});
