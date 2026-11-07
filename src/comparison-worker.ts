/// <reference lib="webworker" />
import { compareTimetables } from "./comparison";
self.onmessage = (e) => {
  try {
    const p = e.data;
    self.postMessage({
      type: "progress",
      message: "改正前／シナリオAを含む2条件を計算中…",
    });
    self.postMessage({
      type: "result",
      result: compareTimetables(
        p.project,
        p.input,
        p.beforeId,
        p.afterId,
        p.config,
        p.origin,
        p.destination,
        p.afterInput,
        p.afterProject,
      ),
    });
  } catch (error) {
    self.postMessage({ type: "error", message: (error as Error).message });
  }
};
