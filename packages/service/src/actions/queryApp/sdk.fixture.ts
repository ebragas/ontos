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
  readonly name: PropType['string'] | undefined;
  readonly phase: PropType['string'] | undefined;
  readonly ownerId: PropType['string'] | undefined;
  readonly cost: PropType['decimal'] | undefined;
  readonly startDate: PropType['datetime'] | undefined;
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
      name: Def<'string', 'nullable'>;
      phase: Def<'string', 'nullable'>;
      ownerId: Def<'string', 'nullable'>;
      cost: Def<'decimal', 'nullable'>;
      startDate: Def<'datetime', 'nullable'>;
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
  readonly engagementId: PropType['string'];
  readonly accountId: PropType['string'] | undefined;
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
      engagementId: Def<'string', 'non-nullable'>;
      accountId: Def<'string', 'nullable'>;
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
