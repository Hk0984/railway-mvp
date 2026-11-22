/// <reference lib="webworker" />
import { buildRoutingIndex } from "./routing";
import { assignRailwayDiagram } from "./diagram-capacity";
import { assignDemand } from "./assignment";
import { assignmentTransfers } from "./diagram-transfers";
import type { Direction } from "./model";
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
    boardingLimitPercent?: number;
    smoothedArrivalShares?: Record<Direction, number[]>;
    compareCapacity?: boolean;
  }>,
) => {
  try {
    const p = event.data,
      index = buildRoutingIndex(p.selections, p.links, {
        includeBoundaryBoards: p.input.some((r) => r.boundaryOriginTrains),
      });
    const fastDiagram =
      p.selections.length === 1 &&
      !p.links.length &&
      p.config.method === "fastest" &&
      p.config.maxTransfers <= 1 &&
      !p.config.capacityConstrained &&
      !p.config.integer &&
      !p.config.arrivalModel &&
      !p.compare &&
      !p.compareCapacity;
    if (
      p.forDiagram &&
      (fastDiagram ||
        p.boardingLimitPercent !== undefined ||
        p.input.some((row) => row.arrivalDirection))
    ) {
      const result = assignRailwayDiagram(
        index,
        p.input,
        p.config,
        p.boardingLimitPercent,
        (done, total, stage) =>
          self.postMessage({ type: "progress", done, total, stage }),
        p.smoothedArrivalShares,
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
    }
    if (p.forDiagram) {
      // The worker validates the full allocation. The diagram needs only its summaries.
      const summaries = results.map((result): DiagramAssignment => {
        const { config, loads, capacity, totals, diagnostics } = result;
        return {
          config,
          loads,
          ...(capacity && { capacity }),
          totals,
          diagnostics,
          transfers: assignmentTransfers(result),
        };
      });
      self.postMessage({ type: "result", results: summaries });
    } else self.postMessage({ type: "result", results });
  } catch (error) {
    self.postMessage({ type: "error", message: (error as Error).message });
  }
};
