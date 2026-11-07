import type { AssignmentResult } from "./assignment-model";
import { stationKey, type JourneyLeg, type StationRef } from "./routing-model";
export interface Flow {
  demandIndex: number;
  cohortId: string;
  origin: StationRef;
  destination: StationRef;
  purpose: string;
  time: number;
  passengers: number;
  state: string;
  legs: JourneyLeg[];
  travelSeconds: number | null;
  waitingSeconds: number | null;
  transfers: number;
}
export function passengerFlows(r: AssignmentResult): Flow[] {
  const cohorts = new Map(r.cohorts.map((c) => [c.id, c]));
  const make = (
    id: string,
    passengers: number,
    legs: JourneyLeg[],
    state: string,
    walking: number,
  ): Flow => {
    const c = cohorts.get(id)!,
      d = r.input[c.demandIndex],
      finished = state === "completed",
      travel =
        finished && legs.length
          ? legs.at(-1)!.arrival - (c.arrival - (d.accessSeconds ?? 0))
          : null;
    return {
      demandIndex: c.demandIndex,
      cohortId: id,
      origin: { datasetId: d.datasetId, stationId: d.origin },
      destination: {
        datasetId: d.destinationDatasetId ?? d.datasetId,
        stationId: d.destination,
      },
      purpose: d.purpose,
      time: c.arrival,
      passengers,
      state,
      legs,
      travelSeconds: travel,
      waitingSeconds:
        travel === null
          ? null
          : Math.max(
              0,
              travel -
                legs.reduce((s, l) => s + l.arrival - l.departure, 0) -
                walking,
            ),
      transfers: Math.max(0, legs.length - 1),
    };
  };
  if (r.capacity)
    return r.capacity.packets.map((p) =>
      make(
        p.cohortId,
        p.passengers,
        p.history,
        p.state,
        (p.walks ?? []).reduce((s, w) => s + w.end - w.start, 0),
      ),
    );
  return [
    ...r.allocations.map((a) => {
      const j = r.journeys[a.journeyId],
        c = cohorts.get(a.cohortId)!,
        d = r.input[c.demandIndex];
      return make(
        a.cohortId,
        a.passengers,
        j.legs,
        "completed",
        j.walkingSeconds + (d.accessSeconds ?? 0),
      );
    }),
    ...r.unallocated.map((a) =>
      make(a.cohortId, a.passengers, [], "noPath", 0),
    ),
  ];
}
export function flowSummary(flows: Flow[]) {
  const sum = (fn: (f: Flow) => number) => flows.reduce((s, f) => s + fn(f), 0),
    completed = sum((f) => (f.state === "completed" ? f.passengers : 0)),
    travel = sum((f) => (f.travelSeconds ?? 0) * f.passengers),
    waiting = sum((f) => (f.waitingSeconds ?? 0) * f.passengers);
  return {
    demand: sum((f) => f.passengers),
    completed,
    untransported: sum((f) => (f.state === "completed" ? 0 : f.passengers)),
    travelPersonSeconds: travel,
    waitingPersonSeconds: waiting,
    meanTravelSeconds: completed ? travel / completed : null,
    meanWaitingSeconds: completed ? waiting / completed : null,
    transferPassengers: sum((f) => (f.transfers > 0 ? f.passengers : 0)),
    excludedTimePassengers: sum((f) =>
      f.travelSeconds === null ? f.passengers : 0,
    ),
  };
}
export function odFlowRows(r: AssignmentResult) {
  const groups = new Map<string, Flow[]>();
  for (const f of passengerFlows(r)) {
    const k = JSON.stringify([
        f.origin.datasetId,
        f.origin.stationId,
        f.destination.datasetId,
        f.destination.stationId,
        f.purpose,
        Math.floor(f.time / 3600),
      ]),
      list = groups.get(k) ?? [];
    list.push(f);
    groups.set(k, list);
  }
  return [...groups].map(([key, flows]) => ({
    key,
    origin: flows[0].origin,
    destination: flows[0].destination,
    purpose: flows[0].purpose,
    hour: Math.floor(flows[0].time / 3600),
    ...flowSummary(flows),
    routes: [
      ...new Set(
        flows.map((f) =>
          f.legs
            .map((l) => `${l.datasetId}/${l.timetableId}/${l.trainId}`)
            .join(" → "),
        ),
      ),
    ],
  }));
}
export function trainContributions(r: AssignmentResult, trainKey: string) {
  const load = (r.capacity?.loads ?? r.loads).find((l) => l.key === trainKey);
  if (!load) return [];
  const peak = load.peakSegments[0];
  if (peak === undefined) return [];
  const contributions = new Map<
    string,
    {
      origin: StationRef;
      destination: StationRef;
      purpose: string;
      passengers: number;
      transferBoardings: number;
    }
  >();
  for (const f of passengerFlows(r)) {
    const i = f.legs.findIndex(
      (l) =>
        JSON.stringify([l.datasetId, l.timetableId, l.trainId]) === trainKey &&
        l.boardIndex <= peak &&
        l.alightIndex > peak,
    );
    if (i < 0) continue;
    const k = JSON.stringify([f.origin, f.destination, f.purpose]),
      row = contributions.get(k) ?? {
        origin: f.origin,
        destination: f.destination,
        purpose: f.purpose,
        passengers: 0,
        transferBoardings: 0,
      };
    row.passengers += f.passengers;
    if (i > 0) row.transferBoardings += f.passengers;
    contributions.set(k, row);
  }
  return [...contributions.values()].sort(
    (a, b) => b.passengers - a.passengers,
  );
}
export function compareBenefits(a: AssignmentResult, b: AssignmentResult) {
  if (JSON.stringify(a.input) !== JSON.stringify(b.input))
    return {
      comparable: false,
      reason: "入力ODが異なるため固定需要の便益を算出しません",
      common: 0,
      excluded: 0,
      improved: 0,
      worsened: 0,
      unchanged: 0,
      travelChangePersonSeconds: 0,
      waitingChangePersonSeconds: 0,
      rows: [] as {
        hour: number;
        passengers: number;
        changePersonSeconds: number;
      }[],
      odRows: [] as {
        origin: StationRef;
        destination: StationRef;
        purpose: string;
        passengers: number;
        changePersonSeconds: number;
        excluded: number;
      }[],
    };
  const af = passengerFlows(a),
    bf = passengerFlows(b),
    rows = new Map<
      number,
      { hour: number; passengers: number; changePersonSeconds: number }
    >();
  const byInput = (flows: Flow[]) => {
      const map = new Map<number, Flow[]>();
      for (const f of flows) {
        const list = map.get(f.demandIndex) ?? [];
        list.push(f);
        map.set(f.demandIndex, list);
      }
      return map;
    },
    ag = byInput(af),
    bg = byInput(bf);
  const odRows = new Map<
    string,
    {
      origin: StationRef;
      destination: StationRef;
      purpose: string;
      passengers: number;
      changePersonSeconds: number;
      excluded: number;
    }
  >();
  let common = 0,
    excluded = 0,
    improved = 0,
    worsened = 0,
    unchanged = 0,
    travel = 0,
    waiting = 0;
  for (let d = 0; d < a.input.length; d++) {
    const left = (ag.get(d) ?? []).sort((x, y) => x.time - y.time),
      right = (bg.get(d) ?? []).sort((x, y) => x.time - y.time);
    const demand = a.input[d],
      odKey = JSON.stringify([
        demand.datasetId,
        demand.origin,
        demand.destinationDatasetId ?? demand.datasetId,
        demand.destination,
        demand.purpose,
      ]),
      od = odRows.get(odKey) ?? {
        origin: { datasetId: demand.datasetId, stationId: demand.origin },
        destination: {
          datasetId: demand.destinationDatasetId ?? demand.datasetId,
          stationId: demand.destination,
        },
        purpose: demand.purpose,
        passengers: 0,
        changePersonSeconds: 0,
        excluded: 0,
      };
    odRows.set(odKey, od);
    let i = 0,
      j = 0,
      la = left[0]?.passengers ?? 0,
      rb = right[0]?.passengers ?? 0;
    while (i < left.length && j < right.length) {
      const n = Math.min(la, rb),
        x = left[i],
        y = right[j];
      if (x.travelSeconds !== null && y.travelSeconds !== null) {
        const change = y.travelSeconds - x.travelSeconds;
        common += n;
        travel += change * n;
        od.passengers += n;
        od.changePersonSeconds += change * n;
        waiting += (y.waitingSeconds! - x.waitingSeconds!) * n;
        if (change < -1e-7) improved += n;
        else if (change > 1e-7) worsened += n;
        else unchanged += n;
        const h = Math.floor(x.time / 3600),
          row = rows.get(h) ?? {
            hour: h,
            passengers: 0,
            changePersonSeconds: 0,
          };
        row.passengers += n;
        row.changePersonSeconds += change * n;
        rows.set(h, row);
      } else {
        excluded += n;
        od.excluded += n;
      }
      la -= n;
      rb -= n;
      if (la < 1e-9) la = left[++i]?.passengers ?? 0;
      if (rb < 1e-9) rb = right[++j]?.passengers ?? 0;
    }
    excluded +=
      left.slice(i).reduce((s, f, k) => s + (k === 0 ? la : f.passengers), 0) +
      right.slice(j).reduce((s, f, k) => s + (k === 0 ? rb : f.passengers), 0);
  }
  return {
    comparable: true,
    reason:
      "同じ入力ODを到着時刻・累積人数順で対応付けた集計比較。ロジットの個人選択を観測した値ではありません。未輸送を0分扱いしません。",
    common,
    excluded,
    improved,
    worsened,
    unchanged,
    travelChangePersonSeconds: travel,
    waitingChangePersonSeconds: waiting,
    rows: [...rows.values()],
    odRows: [...odRows.values()],
  };
}
