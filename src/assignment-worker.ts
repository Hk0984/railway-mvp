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
  }>,
) => {
  try {
    const p = event.data,
      index = buildRoutingIndex(p.selections, p.links);
    const modes = p.compare
      ? (["fastest", "logit"] as const)
      : [p.config.method];
    const results = [];
    for (const method of modes)
      results.push(
        assignDemand(index, p.input, { ...p.config, method }, (done, total) =>
          self.postMessage({ type: "progress", method, done, total }),
        ),
      );
    self.postMessage({ type: "result", results });
  } catch (error) {
    self.postMessage({ type: "error", message: (error as Error).message });
  }
};
