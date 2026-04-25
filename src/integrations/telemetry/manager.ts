import { promises as fs } from "node:fs";
import path from "node:path";
import { fetchDatadogSignals } from "./datadog.js";
import { fetchOtelSignals } from "./otel.js";
import { fetchPosthogSignals } from "./posthog.js";
import { fetchSentrySignals, TelemetrySignal } from "./sentry.js";

export interface ProductionSignalsState {
  schemaVersion: number;
  updatedAt: string | null;
  signals: TelemetrySignal[];
}

export class TelemetryManager {
  constructor(private readonly workspaceRoot: string) {}

  async refresh(): Promise<ProductionSignalsState> {
    const fixture = await this.readFixtureSignals();
    const [sentry, datadog, posthog, otel] = await Promise.all([
      fetchSentrySignals(),
      fetchDatadogSignals(),
      fetchPosthogSignals(),
      fetchOtelSignals()
    ]);
    const merged = dedupeSignals([...fixture, ...sentry, ...datadog, ...posthog, ...otel]);
    const state: ProductionSignalsState = {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      signals: merged
    };
    await this.writeState(state);
    return state;
  }

  async status(): Promise<ProductionSignalsState> {
    const target = this.statePath();
    try {
      const raw = await fs.readFile(target, "utf8");
      return JSON.parse(raw) as ProductionSignalsState;
    } catch {
      return {
        schemaVersion: 1,
        updatedAt: null,
        signals: []
      };
    }
  }

  async topSignals(limit = 10): Promise<TelemetrySignal[]> {
    const state = await this.status();
    return [...state.signals]
      .sort((left, right) => scoreSignal(right) - scoreSignal(left))
      .slice(0, limit);
  }

  private statePath(): string {
    return path.join(this.workspaceRoot, ".mesh", "production-signals.json");
  }

  private async writeState(state: ProductionSignalsState): Promise<void> {
    const target = this.statePath();
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, JSON.stringify(state, null, 2), "utf8");
  }

  private async readFixtureSignals(): Promise<TelemetrySignal[]> {
    const fixturePath = path.join(this.workspaceRoot, ".mesh", "production-fixtures.json");
    try {
      const raw = await fs.readFile(fixturePath, "utf8");
      const parsed = JSON.parse(raw) as TelemetrySignal[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
}

export function scoreSignal(signal: TelemetrySignal): number {
  return signal.requestVolume * Math.log1p(Math.max(0, signal.errorRate)) + signal.revenueImpactDaily;
}

function dedupeSignals(signals: TelemetrySignal[]): TelemetrySignal[] {
  const map = new Map<string, TelemetrySignal>();
  for (const signal of signals) {
    const key = `${signal.file}::${signal.route ?? ""}::${signal.source}`;
    const existing = map.get(key);
    if (!existing || scoreSignal(signal) > scoreSignal(existing)) {
      map.set(key, signal);
    }
  }
  return Array.from(map.values());
}
