class SqlTemplate {
  declare private readonly brand: 'sqlTemplate';
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
}

class ApiName {
  declare private readonly brand: 'apiName';
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
}

class TracedUser {
  declare private readonly brand: 'tracedUser';
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
}

export type { ApiName, SqlTemplate, TracedUser };

export const BRANDS = { sqlTemplate: SqlTemplate, apiName: ApiName, tracedUser: TracedUser } as const;
