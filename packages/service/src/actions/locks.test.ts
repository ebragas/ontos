import { describe, expect, it } from 'vitest';
import type { Edit, ObjectLocator } from './edit.ts';
import { checkedVersions, type LoadedObject } from './objects.ts';
import { lockedObjects } from './write.ts';

const object = (objectType: string, primaryKey: string): ObjectLocator => ({ objectType, primaryKey });
const modify = (object: ObjectLocator): Edit => ({ type: 'modifyObject', object, properties: new Map() });
const create = (object: ObjectLocator): Edit => ({ type: 'addObject', object, properties: new Map() });

const link = (source: ObjectLocator, target: ObjectLocator): Edit => ({
  type: 'addLink',
  link: 'related',
  source,
  target,
});

describe('the Objects that an Action locks', () => {
  it('keeps the first modified or deleted locator in edit order', () => {
    const first = object('Zebra', '2');
    const second = object('Account', '1');

    const { edited, linked } = lockedObjects([
      modify(first),
      { type: 'deleteObject', object: second },
      { type: 'deleteObject', object: { ...first } },
      modify({ ...second }),
    ]);

    expect(edited).toEqual([first, second]);
    expect(edited[0]).toBe(first);
    expect(edited[1]).toBe(second);
    expect(linked).toEqual([]);
  });

  it('keeps the first Link ends in source and target order across repeated, reversed, and self Links', () => {
    const first = object('Zebra', '2');
    const second = object('Account', '1');
    const third = object('Account', '0');

    const { edited, linked } = lockedObjects([
      link(first, second),
      link({ ...first }, { ...second }),
      { type: 'deleteLink', link: 'related', source: { ...second }, target: { ...first } },
      link(third, { ...third }),
    ]);

    expect(edited).toEqual([]);
    expect(linked).toEqual([first, second, third]);
    expect(linked[0]).toBe(first);
    expect(linked[1]).toBe(second);
    expect(linked[2]).toBe(third);
  });

  const editedAccount = object('Account', '1');
  const otherEngagement = object('Engagement', '2');

  it.each([
    ['modifyObject', modify(editedAccount), [editedAccount], editedAccount],
    ['deleteObject', { type: 'deleteObject', object: editedAccount } as const, [editedAccount], editedAccount],
    ['addObject', create(editedAccount), [], undefined],
  ] as const)(
    'excludes %s Objects from Link locks before and after the Object edit',
    (_type, edit, expectedEdited, expectedFirst) => {
      const linked = link({ ...editedAccount }, otherEngagement);

      for (const edits of [
        [linked, edit],
        [edit, linked],
      ]) {
        const locks = lockedObjects(edits);

        expect(locks.edited).toEqual(expectedEdited);
        expect(locks.linked).toEqual([otherEngagement]);
        expect(locks.edited[0]).toBe(expectedFirst);
        expect(locks.linked[0]).toBe(otherEngagement);
      }
    },
  );

  it('keeps a modified Object in edited when a create names it in either order', () => {
    const edited = object('Account', '1');
    const added = create({ ...edited });
    const modified = modify(edited);

    for (const edits of [
      [added, modified],
      [modified, added],
    ]) {
      const locks = lockedObjects([...edits, link({ ...edited }, { ...edited })]);

      expect(locks).toEqual({ edited: [edited], linked: [] });
      expect(locks.edited[0]).toBe(edited);
    }
  });

  it('distinguishes equal primary keys across Object Types and identities with punctuation or non-ASCII text', () => {
    const edited = object('Account', 'same');
    const sameKey = object('Engagement', 'same');
    const punctuation = object('a:b', 'c');
    const movedSeparator = object('a', 'b:c');
    const unicode = object('型["', 'é,雪\\');
    const plain = object('型["', 'e,雪\\');

    const locks = lockedObjects([
      modify(edited),
      link(sameKey, punctuation),
      link(movedSeparator, unicode),
      link({ ...unicode }, plain),
      link({ ...edited }, { ...sameKey }),
    ]);

    expect(locks).toEqual({ edited: [edited], linked: [sameKey, punctuation, movedSeparator, unicode, plain] });
  });

  it('returns no locks for an empty Action or creates alone', () => {
    expect(lockedObjects([])).toEqual({ edited: [], linked: [] });
    expect(lockedObjects([create(object('Account', '1'))])).toEqual({ edited: [], linked: [] });
  });
});

describe('the versions of the locked Objects', () => {
  it('reports the first missing edited Object before Link ends and before sorted lock order', () => {
    const edits = [link(object('A', '0'), object('B', '1')), modify(object('Z', '2')), modify(object('C', '3'))];

    expect(() => checkedVersions(edits, new Map())).toThrow('The rules edit the Z 2, which the apply did not load.');
  });

  it('uses the first loaded version and keeps edited Objects before Link ends', () => {
    const edited = object('Z', '2');
    const linked = object('A', '1');
    const loaded: LoadedObject = { ...edited, version: '7', properties: new Map() };

    const objects = new Map<string, LoadedObject | readonly LoadedObject[]>([
      ['first', [loaded, { ...linked, version: '9', properties: new Map() }]],
      ['duplicate', { ...loaded, version: '8' }],
    ]);

    expect(checkedVersions([link(linked, { ...edited }), modify(edited)], objects)).toEqual([
      { object: edited, version: '7' },
      { object: linked, version: '9' },
    ]);
  });
});
