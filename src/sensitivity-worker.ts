/// <reference lib="webworker" />
import { sensitivityAnalysis } from "./sensitivity";
self.onmessage = (e) => {
  try {
    const p = e.data;
    self.postMessage({
      type: "result",
      rows: sensitivityAnalysis(
        p.project,
        p.timetableId,
        p.config,
        (done, total) => self.postMessage({ type: "progress", done, total }),
      ),
    });
  } catch (error) {
    self.postMessage({ type: "error", message: (error as Error).message });
  }
};
