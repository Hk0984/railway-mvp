import type { IntegrationState } from "./network-model";
import { integrationIndex } from "./network-model";
import type { Project } from "./model";
import type { TransferLink } from "./routing-model";
import type { AssignmentConfig } from "./assignment-model";
import { assignDemand } from "./assignment";
import { allocateVolume } from "./temporal-demand";
import { demandKey } from "./result-conditions";
import { transportCapacity } from "./capacity-model";
import { trainClassKey } from "./classification";
export interface AssignmentScenario {
  name: string;
  config?: Partial<AssignmentConfig>;
  demandFactor?: number;
  waitingFactor?: number;
  capacityFactor?: number;
}
/** Deterministic assumption experiment. Factors can be combined; this is not a confidence interval. */
export function runAssignmentScenario(
  state: IntegrationState,
  projects: Project[],
  links: TransferLink[],
  scenario: AssignmentScenario,
  onProgress?: Parameters<typeof assignDemand>[3],
) {
  for (const v of [
    scenario.demandFactor,
    scenario.waitingFactor,
    scenario.capacityFactor,
  ])
    if (v !== undefined && (!Number.isFinite(v) || v < 0))
      throw Error("シナリオ倍率は有限の非負数です");
  const config = structuredClone({ ...state.config, ...scenario.config }),
    input = structuredClone(state.demands);
  let ps = projects;
  if (scenario.demandFactor !== undefined && scenario.demandFactor !== 1) {
    const order = input
        .map((d, i) => ({ key: demandKey(d), i }))
        .sort((a, b) => a.key.localeCompare(b.key)),
      total =
        input.reduce((s, d) => s + d.passengers, 0) * scenario.demandFactor,
      counts = allocateVolume(
        config.integer ? Math.round(total) : total,
        order.map((v) => input[v.i].passengers),
        config.integer,
      );
    order.forEach((v, j) => {
      input[v.i].passengers = counts[j];
      input[v.i].source = "estimated";
    });
  }
  if (scenario.waitingFactor !== undefined)
    Object.values(config.coefficients).forEach(
      (c) => (c.waiting *= scenario.waitingFactor!),
    );
  if (scenario.capacityFactor !== undefined) {
    ps = structuredClone(projects);
    for (const p of ps) {
      p.capacitySettings ??= { timetables: {}, trains: {}, types: {} };
      for (const d of p.timetables)
        for (const t of d.trains) {
          const cap = transportCapacity(p, d.id, t.id);
          if (cap !== null) {
            const value = cap * scenario.capacityFactor;
            if (value <= 0) throw Error("輸送定員0のシナリオは未対応です");
            p.capacitySettings.trains[trainClassKey(d.id, t.id)] = {
              value: Math.max(1, Math.round(value)),
              kind: "transport",
              basis: scenario.name,
            };
          }
        }
    }
  }
  const copy = { ...state, config, demands: input },
    idx = integrationIndex(copy, ps, links),
    r = assignDemand(idx, input, config, onProgress);
  r.scenario = {
    ...scenario,
    inputTotal: input.reduce((s, d) => s + d.passengers, 0),
    note: "設定したシナリオ。整数の需要倍率はシナリオ全体の人数を四捨五入後に最大剰余配分。実測の倍率変更は推計扱い。",
  };
  return r;
}
