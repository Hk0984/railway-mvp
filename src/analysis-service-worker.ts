/// <reference lib="webworker" />
import { buildRoutingIndex } from "./routing";
import { analyzeService } from "./service";
self.onmessage = (e) => {
  try {
    const {
      project,
      timetableId,
      origin,
      destination,
      start,
      end,
      maxTransfers,
      minimumTransferSeconds,
    } = e.data;
    const index = buildRoutingIndex([
      { project, datasetId: project.datasetId, timetableId },
    ]);
    self.postMessage({
      type: "result",
      result: analyzeService(
        index,
        {
          origin: { datasetId: project.datasetId, stationId: origin },
          destination: { datasetId: project.datasetId, stationId: destination },
          time: start,
          mode: "depart",
          sort: "arrival",
          maxTransfers,
          minimumTransferSeconds,
          directOnly: maxTransfers === 0,
        },
        start,
        end,
      ),
    });
  } catch (e) {
    self.postMessage({ type: "error", message: (e as Error).message });
  }
};
