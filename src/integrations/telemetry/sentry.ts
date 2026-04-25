export interface TelemetrySignal {
  file: string;
  route?: string;
  errorRate: number;
  requestVolume: number;
  p99Ms: number;
  revenueImpactDaily: number;
  source: string;
}

export async function fetchSentrySignals(): Promise<TelemetrySignal[]> {
  return [];
}
