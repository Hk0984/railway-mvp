/// <reference lib="webworker" />
import { buildRoutingIndex } from "./routing";
import { assignDemand } from "./assignment";
import type { DatasetSelection, TransferLink } from "./routing-model";
import type { AssignmentDemand, AssignmentConfig } from "./assignment-model";
self.onmessage = (
  event: MessageEvent<{
    selections: DatasetSelection[];
    links: TransferLink[];
    input: AssignmentDemand[];
    config: AssignmentConfig;
    compare: boolean;
    compareCapacity?: boolean;
  }>,
) => {
  try {
    const p = event.data,
      index = buildRoutingIndex(p.selections, p.links);
    const modes = p.compare
      ? (["fastest", "logit"] as const)
      : [p.config.method];
    const results = [];
    const configs = p.compareCapacity
      ? [
          { ...p.config, capacityConstrained: false },
          { ...p.config, capacityConstrained: true },
        ]
      : modes.map((method) => ({ ...p.config, method }));
    for (const config of configs)
      results.push(
        assignDemand(index, p.input, config, (done, total, stage) =>
          self.postMessage({
            type: "progress",
            method: config.method,
            done,
            total,
            stage,
          }),
        ),
      );
    self.postMessage({ type: "result", results });
  } catch (error) {
    self.postMessage({ type: "error", message: (error as Error).message });
  }
};
