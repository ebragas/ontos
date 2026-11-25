import type { ObjectSet, ObjectTypeDefinition, PropertyValueWireToClient as PropType } from '@osdk/client';

const osdkMetadata = { extraUserAgent: '' };

interface Def<T, N extends 'nullable' | 'non-nullable'> {
  type: T;
  multiplicity: false;
  nullable: N extends 'nullable' ? true : false;
}

type None = Record<string, never>;

interface Common {
  description: undefined;
  icon: undefined;
  implements: [];
  interfaceMap: None;
  inverseInterfaceMap: None;
  links: None;
  linksType: None;
  pluralDisplayName: '';
  rid: string;
  status: 'ACTIVE';
  type: 'object';
  visibility: undefined;
}

interface AccountProps {
  readonly accountId: PropType['string'];
  readonly active: PropType['boolean'] | undefined;
  readonly name: PropType['string'] | undefined;
  readonly note: PropType['string'] | undefined;
  readonly phase: PropType['string'] | undefined;
}

export interface Account extends ObjectTypeDefinition {
  osdkMetadata: typeof osdkMetadata;
  type: 'object';
  apiName: 'com.example.twin.Account';
  primaryKeyApiName: 'accountId';
  primaryKeyType: 'string';
  __DefinitionMetadata?: Common & {
    objectSet: ObjectSet<Account>;
    props: AccountProps;
    strictProps: AccountProps;
    apiName: 'com.example.twin.Account';
    displayName: 'Account';
    primaryKeyApiName: 'accountId';
    primaryKeyType: 'string';
    titleProperty: 'name';
    properties: {
      accountId: Def<'string', 'non-nullable'>;
      active: Def<'boolean', 'nullable'>;
      name: Def<'string', 'nullable'>;
      note: Def<'string', 'nullable'>;
      phase: Def<'string', 'nullable'>;
    };
  };
}

export const Account = {
  type: 'object',
  apiName: 'com.example.twin.Account',
  osdkMetadata,
  primaryKeyApiName: 'accountId',
  primaryKeyType: 'string',
} satisfies Account as Account;

interface EngagementProps {
  readonly accountId: PropType['string'] | undefined;
  readonly amount: PropType['double'] | undefined;
  readonly createdAt: PropType['timestamp'] | undefined;
  readonly engagementId: PropType['string'];
  readonly status: PropType['string'] | undefined;
  readonly title: PropType['string'] | undefined;
}

export interface Engagement extends ObjectTypeDefinition {
  osdkMetadata: typeof osdkMetadata;
  type: 'object';
  apiName: 'com.example.twin.Engagement';
  primaryKeyApiName: 'engagementId';
  primaryKeyType: 'string';
  __DefinitionMetadata?: Common & {
    objectSet: ObjectSet<Engagement>;
    props: EngagementProps;
    strictProps: EngagementProps;
    apiName: 'com.example.twin.Engagement';
    displayName: 'Engagement';
    primaryKeyApiName: 'engagementId';
    primaryKeyType: 'string';
    titleProperty: 'title';
    properties: {
      accountId: Def<'string', 'nullable'>;
      amount: Def<'double', 'nullable'>;
      createdAt: Def<'timestamp', 'nullable'>;
      engagementId: Def<'string', 'non-nullable'>;
      status: Def<'string', 'nullable'>;
      title: Def<'string', 'nullable'>;
    };
  };
}

export const Engagement = {
  type: 'object',
  apiName: 'com.example.twin.Engagement',
  osdkMetadata,
  primaryKeyApiName: 'engagementId',
  primaryKeyType: 'string',
} satisfies Engagement as Engagement;

interface StructProbeProps {
  readonly measures:
    | {
        at: PropType['timestamp'] | undefined;
        count: PropType['integer'] | undefined;
        flag: PropType['boolean'] | undefined;
        score: PropType['double'] | undefined;
      }
    | undefined;
  readonly probeId: PropType['string'];
  readonly relationship: { label: PropType['string'] | undefined; since: PropType['datetime'] | undefined } | undefined;
}

export interface StructProbe extends ObjectTypeDefinition {
  osdkMetadata: typeof osdkMetadata;
  type: 'object';
  apiName: 'com.example.twin.StructProbe';
  primaryKeyApiName: 'probeId';
  primaryKeyType: 'string';
  __DefinitionMetadata?: Common & {
    objectSet: ObjectSet<StructProbe>;
    props: StructProbeProps;
    strictProps: StructProbeProps;
    apiName: 'com.example.twin.StructProbe';
    displayName: 'StructProbe';
    primaryKeyApiName: 'probeId';
    primaryKeyType: 'string';
    titleProperty: 'probeId';
    properties: {
      measures: Def<{ at: 'timestamp'; count: 'integer'; flag: 'boolean'; score: 'double' }, 'nullable'>;
      probeId: Def<'string', 'non-nullable'>;
      relationship: Def<{ label: 'string'; since: 'datetime' }, 'nullable'>;
    };
  };
}

export const StructProbe = {
  type: 'object',
  apiName: 'com.example.twin.StructProbe',
  osdkMetadata,
  primaryKeyApiName: 'probeId',
  primaryKeyType: 'string',
} satisfies StructProbe as StructProbe;
