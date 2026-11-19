/// <reference lib="webworker" />
import { buildRoutingIndex } from "./routing";
import { assignDemand } from "./assignment";
import { assignDestinationArrivals } from "./destination-assignment";
import { lineAssignmentProfile } from "./line-assignment-profile";
import type { DatasetSelection, TransferLink } from "./routing-model";
import type {
  AssignmentDemand,
  AssignmentConfig,
  DiagramAssignment,
} from "./assignment-model";
self.onmessage = (
  event: MessageEvent<{
    selections: DatasetSelection[];
    links: TransferLink[];
    input: AssignmentDemand[];
    config: AssignmentConfig;
    compare: boolean;
    forDiagram?: boolean;
    compareCapacity?: boolean;
  }>,
) => {
  try {
    const p = event.data,
      index = buildRoutingIndex(p.selections, p.links, {
        includeBoundaryBoards: p.input.some((r) => r.boundaryOriginTrains),
      });
    if (p.forDiagram && p.input.some((row) => row.arrivalDirection)) {
      const result = assignDestinationArrivals(
        index,
        p.input,
        p.config,
        (done, total) => self.postMessage({ type: "progress", done, total }),
      );
      self.postMessage({ type: "result", results: [result] });
      return;
    }
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
    for (const config of configs) {
      const fast =
        p.forDiagram &&
        p.selections.length === 1 &&
        !p.links.length &&
        config.method === "fastest" &&
        config.maxTransfers <= 1 &&
        !config.capacityConstrained &&
        !config.integer &&
        !config.arrivalModel;
      results.push(
        assignDemand(
          index,
          p.input,
          config,
          (done, total, stage) =>
            self.postMessage({
              type: "progress",
              method: config.method,
              done,
              total,
              stage,
            }),
          fast ? lineAssignmentProfile(index) : undefined,
        ),
      );
    }
    if (p.forDiagram) {
      // The worker validates the full allocation. The diagram needs only its summaries.
      const summaries = results.map(
        ({
          config,
          loads,
          capacity,
          totals,
          diagnostics,
        }): DiagramAssignment => ({
          config,
          loads,
          ...(capacity && { capacity }),
          totals,
          diagnostics,
        }),
      );
      self.postMessage({ type: "result", results: summaries });
    } else self.postMessage({ type: "result", results });
  } catch (error) {
    self.postMessage({ type: "error", message: (error as Error).message });
  }
};
