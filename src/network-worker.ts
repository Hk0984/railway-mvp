/// <reference lib="webworker" />
import { integrationIndex } from "./network-model";
import { assignDemand } from "./assignment";
self.onmessage = (e) => {
  try {
    const { state, projects, links, compareArrival } = e.data,
      index = integrationIndex(state, projects, links),
      configs = compareArrival
        ? [
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
          ]
        : [state.config];
    const results = [];
    for (const config of configs)
      results.push(
        assignDemand(index, state.demands, config, (done, total, stage) =>
          self.postMessage({
            type: "progress",
            done,
            total,
            stage,
            mode: config.arrivalModel?.mode,
          }),
        ),
      );
    self.postMessage({ type: "result", results });
  } catch (error) {
    self.postMessage({ type: "error", message: (error as Error).message });
  }
};
