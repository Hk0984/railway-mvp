import type { AssignmentResult } from "./assignment-model";
import { odFlowRows } from "./flow-analysis";
export function comparisonFacts(a: AssignmentResult, b: AssignmentResult) {
  const ag = new Map(odFlowRows(a).map((r) => [r.key, r])),
    bg = new Map(odFlowRows(b).map((r) => [r.key, r]));
  const od = [...new Set([...ag.keys(), ...bg.keys()])]
    .map((key) => {
      const x = ag.get(key),
        y = bg.get(key);
      return {
        key,
        before: x ?? null,
        after: y ?? null,
        completedChange: (y?.completed ?? 0) - (x?.completed ?? 0),
        untransportedChange: (y?.untransported ?? 0) - (x?.untransported ?? 0),
        meanWaitChangeSeconds:
          x?.meanWaitingSeconds !== null &&
          x?.meanWaitingSeconds !== undefined &&
          y?.meanWaitingSeconds !== null &&
          y?.meanWaitingSeconds !== undefined
            ? y.meanWaitingSeconds - x.meanWaitingSeconds
            : null,
      };
    })
    .sort(
      (x, y) =>
        Math.abs(y.untransportedChange) - Math.abs(x.untransportedChange) ||
        Math.abs(y.meanWaitChangeSeconds ?? 0) -
          Math.abs(x.meanWaitChangeSeconds ?? 0),
    );
  const al = new Map((a.capacity?.loads ?? a.loads).map((l) => [l.key, l])),
    bl = new Map((b.capacity?.loads ?? b.loads).map((l) => [l.key, l]));
  const trains = [...new Set([...al.keys(), ...bl.keys()])]
    .map((key) => ({
      key,
      before: al.get(key)?.peakLoad ?? 0,
      after: bl.get(key)?.peakLoad ?? 0,
      beforePeakSegments: al.get(key)?.peakSegments ?? [],
      afterPeakSegments: bl.get(key)?.peakSegments ?? [],
      difference: (bl.get(key)?.peakLoad ?? 0) - (al.get(key)?.peakLoad ?? 0),
    }))
    .sort((x, y) => Math.abs(y.difference) - Math.abs(x.difference));
  const denied = (r: AssignmentResult) => {
      const m = new Map<string, number>();
      for (const e of r.capacity?.events ?? [])
        if (e.type === "denied") {
          const key = JSON.stringify([
            e.datasetId ?? r.input[0]?.datasetId,
            e.stationId,
            Math.floor(e.time / 3600),
          ]);
          m.set(key, (m.get(key) ?? 0) + e.passengers);
        }
      return m;
    },
    ad = denied(a),
    bd = denied(b),
    stations = [...new Set([...ad.keys(), ...bd.keys()])]
      .map((key) => ({
        key,
        before: ad.get(key) ?? 0,
        after: bd.get(key) ?? 0,
        difference: (bd.get(key) ?? 0) - (ad.get(key) ?? 0),
      }))
      .sort((x, y) => Math.abs(y.difference) - Math.abs(x.difference));
  return {
    od,
    trains,
    stations,
    note: "人数・待ち時間・最大断面・積み残し人回の差分です。原因を推定したものではありません。別ダイヤの列車キーは同一列車と見なさず、追加・除去を含めて表示します。",
  };
}
