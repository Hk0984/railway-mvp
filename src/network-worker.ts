/// <reference lib="webworker" />
import { integrationIndex } from "./network-model";
import { assignDemand } from "./assignment";
import type { AssignmentConfig } from "./assignment-model";
import type { ArrivalModel } from "./arrival-distribution";
import {
  runAssignmentScenario,
  type AssignmentScenario,
} from "./assignment-scenarios";
self.onmessage = (e) => {
  try {
    const { state, projects, links, compareArrival, experiment } = e.data,
      begin = performance.now(),
      index = integrationIndex(state, projects, links),
      indexMs = performance.now() - begin;
    let configs: AssignmentConfig[] = [state.config],
      labels = ["保存条件"];
    if (compareArrival) {
      configs = [
        {
          ...state.config,
          arrivalModel: {
            mode: "representative",
            distribution: "uniform",
            stepSeconds: 60,
          },
        },
        {
          ...state.config,
          arrivalModel: { ...state.config.arrivalModel, mode: "minute" },
        },
      ];
      labels = ["代表時刻・一様", "保存した分布"];
    }
    if (experiment === "precision") {
      const m = state.config.arrivalModel ?? {
        distribution: "uniform",
        stepSeconds: 60,
      };
      configs = (["midpoint", "start", "uniform", "weighted"] as const).map(
        (timing) => ({
          ...state.config,
          arrivalModel: {
            ...m,
            mode: "minute",
            timing,
            integrationSeconds: m.integrationSeconds ?? 1,
            distribution: timing === "uniform" ? "uniform" : m.distribution,
          } as ArrivalModel,
        }),
      );
      labels = ["A：枠中点", "B：枠開始", "C：一様積分", "D：指定分布積分"];
    }
    if (experiment === "scenario-range") {
      const specs: AssignmentScenario[] = [
        { name: "基準" },
        { name: "需要量×0.8", demandFactor: 0.8 },
        { name: "需要量×1.2", demandFactor: 1.2 },
        {
          name: "最低乗換×0.8",
          config: {
            minimumTransferSeconds: state.config.minimumTransferSeconds * 0.8,
          },
        },
        {
          name: "最低乗換×1.2",
          config: {
            minimumTransferSeconds: state.config.minimumTransferSeconds * 1.2,
          },
        },
        {
          name: "前半集中・5秒積分",
          config: {
            arrivalModel: {
              ...(state.config.arrivalModel ?? { stepSeconds: 60 }),
              mode: "minute",
              timing: "weighted",
              distribution: "front",
              integrationSeconds: 5,
            },
          },
        },
        {
          name: "後半集中・5秒積分",
          config: {
            arrivalModel: {
              ...(state.config.arrivalModel ?? { stepSeconds: 60 }),
              mode: "minute",
              timing: "weighted",
              distribution: "back",
              integrationSeconds: 5,
            },
          },
        },
        { name: "既知定員×0.8", capacityFactor: 0.8 },
        { name: "既知定員×1.2", capacityFactor: 1.2 },
        { name: "待ち選択係数×1.2", waitingFactor: 1.2 },
        {
          name: "複合：需要×1.2・定員×0.8",
          demandFactor: 1.2,
          capacityFactor: 0.8,
        },
      ];
      const results = specs.map((spec, i) => {
        self.postMessage({
          type: "progress",
          done: i,
          total: specs.length,
          mode: "minute",
          stage: "od",
        });
        return runAssignmentScenario(state, projects, links, spec);
      });
      self.postMessage({
        type: "result",
        results,
        labels: specs.map((s) => s.name),
        workerComputeMs: performance.now() - begin,
        sentAt: performance.timeOrigin + performance.now(),
      });
      return;
    }
    const results = [];
    for (const [i, config] of configs.entries()) {
      const idx = index;
      const r = assignDemand(idx, state.demands, config, (done, total, stage) =>
        self.postMessage({
          type: "progress",
          done,
          total,
          stage,
          mode: config.arrivalModel?.mode,
        }),
      );
      r.diagnostics.timings = { ...r.diagnostics.timings, indexMs };
      results.push(r);
    }
    self.postMessage({
      type: "result",
      results,
      labels,
      workerComputeMs: performance.now() - begin,
      sentAt: performance.timeOrigin + performance.now(),
    });
  } catch (error) {
    self.postMessage({ type: "error", message: (error as Error).message });
  }
};
