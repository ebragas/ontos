interface ChartPoint {
  readonly day: string;
  readonly balance: string;
}

export interface ScenarioChart {
  readonly label: string;
  readonly thirty: ChartPoint[];
  readonly sixty: ChartPoint[];
}

export default async function scenarioChart(): Promise<ScenarioChart> {
  return {
    label: 'Runway',
    thirty: [
      { day: '2026-12-01', balance: '100.10' },
      { day: '2026-12-31', balance: '50' },
    ],
    sixty: [],
  };
}
