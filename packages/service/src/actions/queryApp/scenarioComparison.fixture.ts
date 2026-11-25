import type { Client } from '@osdk/client';

export interface Scenario {
  readonly days: number;
  readonly balance: string;
  readonly runwayDate?: string;
}

export default async function scenarioComparison(_client: Client, balance: string): Promise<Scenario[]> {
  return [
    { days: 30, balance, runwayDate: '2027-01-31' },
    { days: 60, balance: '-75.25', runwayDate: '2027-03-02' },
    { days: 90, balance: '12345678901234567890.12' },
  ];
}
