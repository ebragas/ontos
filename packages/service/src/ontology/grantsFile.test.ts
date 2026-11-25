import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseGrantsFile } from './index.ts';
import { ATTRIBUTE_DECLARATIONS, NS, twinGrantsFile } from './stored.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const CREATE_ACCOUNT = `${NS}create-account`;

const SPEC_FILE = {
  permissions: {
    'accounts:read': { description: 'View accounts' },
    'accounts:write': { description: 'Create and change accounts' },
  },
  objectTypes: { Account: 'accounts:read' },
  actionTypes: { 'create-account': 'accounts:write' },
  defaultRoles: { admin: ['ontology:install', 'accounts:read', 'accounts:write'], member: ['accounts:read'] },
};

describe('the grants file', () => {
  it('service/ontology-as-code#the-grants-file: the grants file of the twin parses into its permissions and its default roles', () => {
    const raw: unknown = JSON.parse(
      readFileSync(new URL('../../twin/ontology/0.7.0/grants.json', import.meta.url), 'utf8'),
    );

    const grants = twinGrantsFile();

    expect(parseGrantsFile(raw)).toEqual({ grants });

    expect(Object.keys(grants.permissions)).toEqual([
      'accounts:read',
      'accounts:write',
      'accounts:close',
      'engagements:read',
      'engagements:write',
      'probes:read',
      'probes:write',
    ]);

    expect(grants.objectTypes[ACCOUNT]).toBe('accounts:read');
    expect(grants.actionTypes[CREATE_ACCOUNT]).toBe('accounts:write');

    expect(grants.defaultRoles).toEqual({
      admin: [
        'ontology:install',
        'accounts:read',
        'accounts:write',
        'accounts:close',
        'engagements:read',
        'engagements:write',
        'probes:read',
        'probes:write',
      ],
      member: ['accounts:read', 'accounts:write', 'engagements:read', 'probes:read'],
    });
  });

  it('service/ontology-as-code#the-grants-file: the 4 required keys parse as they are', () => {
    expect(parseGrantsFile(SPEC_FILE)).toEqual({ grants: SPEC_FILE });
  });

  it.each([
    ['a list', [], 'The grants file is not a JSON object.'],
    [
      'no permissions',
      { objectTypes: {}, actionTypes: {}, defaultRoles: {} },
      'The grants file has no key permissions.',
    ],
    [
      'no objectTypes',
      { permissions: {}, actionTypes: {}, defaultRoles: {} },
      'The grants file has no key objectTypes.',
    ],
    [
      'no actionTypes',
      { permissions: {}, objectTypes: {}, defaultRoles: {} },
      'The grants file has no key actionTypes.',
    ],
    [
      'no defaultRoles',
      { permissions: {}, objectTypes: {}, actionTypes: {} },
      'The grants file has no key defaultRoles.',
    ],
    [
      'a 6th key',
      { ...SPEC_FILE, linkTypes: {} },
      'The grants file has the key linkTypes. Its keys are permissions, objectTypes, actionTypes, defaultRoles, queryTypes, and personAttributes.',
    ],
    ['permissions that is a list', { ...SPEC_FILE, permissions: [] }, 'permissions is not a JSON object.'],
    [
      'a permission with no description',
      { ...SPEC_FILE, permissions: { 'accounts:read': {} } },
      'The permission accounts:read is not an object with only the String description.',
    ],
    [
      'a description that is not a String',
      { ...SPEC_FILE, permissions: { 'accounts:read': { description: 1 } } },
      'The permission accounts:read is not an object with only the String description.',
    ],
    [
      'a permission with a name',
      { ...SPEC_FILE, permissions: { 'accounts:read': { description: 'View accounts', name: 'Read' } } },
      'The permission accounts:read is not an object with only the String description.',
    ],
    [
      'an Object Type with a list of permissions',
      { ...SPEC_FILE, objectTypes: { Account: ['accounts:read'] } },
      'Account of objectTypes names no permission slug.',
    ],
    [
      'an Action Type with no permission',
      { ...SPEC_FILE, actionTypes: { 'create-account': null } },
      'create-account of actionTypes names no permission slug.',
    ],
    [
      'actionTypes that is a String',
      { ...SPEC_FILE, actionTypes: 'accounts:write' },
      'actionTypes is not a JSON object.',
    ],
    ['defaultRoles that is a list', { ...SPEC_FILE, defaultRoles: [] }, 'defaultRoles is not a JSON object.'],
    [
      'a default role with 1 slug, not a list',
      { ...SPEC_FILE, defaultRoles: { admin: 'accounts:read' } },
      'The default role admin is not a list of permission slugs.',
    ],
    [
      'a default role with a number',
      { ...SPEC_FILE, defaultRoles: { admin: [1] } },
      'The default role admin is not a list of permission slugs.',
    ],
  ])(
    'service/ontology-as-code#the-grants-file: a grants file with %s does not parse, and the problem names it',
    (_name, file, problem) => {
      expect(parseGrantsFile(file)).toEqual({ problem });
    },
  );

  it('service/ontology-as-code#the-grants-file: personAttributes is optional, and parses when it is there', () => {
    expect(parseGrantsFile(SPEC_FILE)).not.toHaveProperty('grants.personAttributes');

    const withAttributes = { ...SPEC_FILE, personAttributes: ATTRIBUTE_DECLARATIONS };

    expect(parseGrantsFile(withAttributes)).toEqual({ grants: withAttributes });
  });

  it('service/ontology-as-code#the-grants-file: a personAttributes of another shape does not parse', () => {
    const bad = { ...SPEC_FILE, personAttributes: { jobsiteIds: { start: { objectType: 'CrewMember' }, links: [] } } };

    expect(parseGrantsFile(bad)).toEqual({ problem: 'personAttributes is not a map of Person attribute paths.' });
  });

  it('service/publish#grants-check: a grants file of v2, with the key roles, does not parse', () => {
    const v2 = {
      roles: ['admin', 'member'],
      objectTypes: { 'com.example.twin.Account': ['admin', 'member'] },
      actionTypes: { 'com.example.twin.create-account': ['admin', 'member'] },
    };

    expect(parseGrantsFile(v2)).toEqual({
      problem:
        'The grants file has the key roles. Its keys are permissions, objectTypes, actionTypes, defaultRoles, queryTypes, and personAttributes.',
    });
  });
});
