import { trainVisits } from "./analysis";
import type { AssignmentDemand } from "./assignment-model";
import { isPassengerTrain } from "./classification";
import type { Project, Timetable, Train } from "./model";

export const periods = [
  { label: "朝", note: "06:00–10:00", from: 6, to: 10 },
  { label: "日中", note: "10:00–16:00", from: 10, to: 16 },
  { label: "夕方", note: "16:00–20:00", from: 16, to: 20 },
  { label: "夜・早朝", note: "20:00–翌06:00", from: 20, to: 30 },
] as const;
export type Flow = "local" | "inbound" | "outbound";

interface StationCounts {
  board: number;
  alight: number;
  weight: number;
}
export interface OutsideArea {
  id: string;
  name: string;
  stationId: string;
  inbound: number;
  outbound: number;
  included: boolean;
  mode: "transfer" | "through";
  trains: Record<string, { inbound: string[]; outbound: string[] }>;
}
export interface LineDemand {
  counts: Record<string, StationCounts>;
  shares: Record<"local", number[]> &
    Partial<Record<"inbound" | "outbound", number[]>>;
  outside: OutsideArea[];
}

export function defaultLineDemand(sample = false): LineDemand {
  const counts = sample
    ? Object.fromEntries(
        [9600, 5700, 8200, 7100, 5400].map((number, i) => [
          `s${i}`,
          { board: number, alight: number, weight: 1 },
        ]),
      )
    : {};
  return { counts, shares: { local: [40, 25, 28, 7] }, outside: [] };
}

export function boundaryTrains(
  dia: Timetable,
  stationId: string,
  flow: "inbound" | "outbound",
) {
  return dia.trains.filter((train) => {
    const endpoint =
      flow === "inbound" ? train.externalOrigin : train.externalDestination;
    if (
      train.cancelled ||
      (endpoint && endpoint.boundaryStationId !== stationId)
    )
      return false;
    const stops = trainVisits(train);
    const edge = flow === "inbound" ? stops[0] : stops.at(-1);
    return (
      stops.length > 1 &&
      edge?.stationId === stationId &&
      (edge.departure !== undefined || edge.arrival !== undefined)
    );
  });
}

const nonnegative = (v: number) => Number.isFinite(v) && v >= 0 && v <= 1e9;
export function validateLineDemand(project: Project) {
  const d = project.lineDemand;
  if (d === undefined) return;
  if (!d || !d.counts || !d.shares || !Array.isArray(d.outside))
    throw new Error("需要設定の形式を確認してください");
  const stationIds = new Set(project.stations.map((s) => s.id));
  for (const [id, v] of Object.entries(d.counts)) {
    if (
      !stationIds.has(id) ||
      !v ||
      ![v.board, v.alight, v.weight].every(nonnegative)
    )
      throw new Error("駅別人数と行先の重みには0以上の数値を入力してください");
  }
  for (const flow of ["local", "inbound", "outbound"] as const) {
    const shares = d.shares[flow];
    if (flow !== "local" && shares === undefined) continue;
    if (
      !Array.isArray(shares) ||
      shares.length !== periods.length ||
      !shares.every(nonnegative) ||
      Math.abs(shares.reduce((a, b) => a + b, 0) - 100) > 1e-6
    )
      throw new Error("時間帯の割合は各設定で合計100%にしてください");
  }
  const ids = new Set<string>();
  for (const a of d.outside) {
    if (
      !a ||
      typeof a.id !== "string" ||
      ids.has(a.id) ||
      typeof a.name !== "string" ||
      !a.name.trim() ||
      !stationIds.has(a.stationId) ||
      ![a.inbound, a.outbound].every(nonnegative) ||
      typeof a.included !== "boolean" ||
      !["transfer", "through"].includes(a.mode) ||
      !a.trains ||
      typeof a.trains !== "object" ||
      Array.isArray(a.trains)
    )
      throw new Error("路線外方面の名称・接続駅・人数を確認してください");
    ids.add(a.id);
    for (const [id, selection] of Object.entries(a.trains)) {
      const dia = project.timetables.find((t) => t.id === id);
      if (!dia || !selection)
        throw new Error("直通列車の設定ダイヤが存在しません");
      for (const flow of ["inbound", "outbound"] as const) {
        const chosen = selection[flow];
        if (!Array.isArray(chosen) || chosen.some((v) => typeof v !== "string"))
          throw new Error("直通列車の指定が不正です");
        if (!chosen.length) continue;
        const eligible = new Set(
          boundaryTrains(dia, a.stationId, flow).map((t) => t.id),
        );
        if (chosen.some((v) => !eligible.has(v)))
          throw new Error("直通列車と接続駅の組み合わせを確認してください");
      }
    }
  }
}

export function serviceDay(project: Project) {
  const start = project.oud2?.serviceDayStart ?? 4 * 3600;
  return { start, end: start + 86400 };
}

function timeWindows(start: number, end: number) {
  return periods.map(({ from, to }) =>
    [-1, 0, 1, 2].flatMap((day) => {
      const a = Math.max(start, (day * 24 + from) * 3600);
      const b = Math.min(end, (day * 24 + to) * 3600);
      return a < b ? [{ start: a, end: b }] : [];
    }),
  );
}

function reachability(trains: Train[]) {
  const direct = new Map<string, Set<string>>();
  for (const train of trains) {
    const from = new Set<string>();
    for (const stop of trainVisits(train)) {
      if (stop.status !== "stop") continue;
      if (stop.dropoffAllowed !== false && stop.arrival !== undefined)
        for (const id of from) {
          const to = direct.get(id) ?? new Set<string>();
          to.add(stop.stationId);
          direct.set(id, to);
        }
      if (stop.pickupAllowed !== false && stop.departure !== undefined)
        from.add(stop.stationId);
    }
  }
  return (from: string) => {
    const first = direct.get(from) ?? [];
    const reachable = new Set(first);
    for (const via of first)
      for (const to of direct.get(via) ?? []) reachable.add(to);
    reachable.delete(from);
    return reachable;
  };
}

export function estimateLineDemand(project: Project, diaId: string) {
  validateLineDemand(project);
  const settings = project.lineDemand ?? defaultLineDemand();
  const ids = project.stations.map((s) => s.id);
  const dia = project.timetables.find((t) => t.id === diaId)!;
  const passenger = dia.trains.filter((t) =>
    isPassengerTrain(project, diaId, t),
  );
  const from = reachability(passenger);
  const routes = new Map(ids.map((id) => [id, from(id)]));
  const board = new Map(ids.map((id) => [id, settings.counts[id]?.board ?? 0]));
  const alight = new Map(
    ids.map((id) => [id, settings.counts[id]?.alight ?? 0]),
  );
  const weight = (id: string) => settings.counts[id]?.weight ?? 1;
  for (const area of settings.outside) {
    if (!area.included) continue;
    const b = board.get(area.stationId)! - area.inbound;
    const a = alight.get(area.stationId)! - area.outbound;
    if (b < 0 || a < 0)
      throw new Error(
        `${area.name}：内数が接続駅の乗車・降車人数を超えています`,
      );
    board.set(area.stationId, b);
    alight.set(area.stationId, a);
  }
  const total = (values: Iterable<number>) =>
    [...values].reduce((a, b) => a + b, 0);
  const dailyBoard = total(board.values());
  const dailyAlight = total(alight.values());
  const { start, end } = serviceDay(project);
  const windows = timeWindows(start, end);
  const rows: AssignmentDemand[] = [];
  const destinations = new Map<string, number>();
  const byTime = periods.map(() => 0);
  const external = { inbound: 0, outbound: 0 };
  const warnings: string[] = [];
  let rejected = 0;
  const add = (
    origin: string,
    destination: string,
    amount: number,
    flow: Flow,
    trains?: string[],
    area?: string,
  ) => {
    if (!(amount > 0)) return;
    const label = flow === "outbound" && area ? area : destination;
    destinations.set(label, (destinations.get(label) ?? 0) + amount);
    if (flow !== "local") external[flow] += amount;
    const shares = settings.shares[flow] ?? settings.shares.local;
    for (const [i, intervals] of windows.entries()) {
      const volume = (amount * shares[i]) / 100;
      if (!volume) continue;
      byTime[i] += volume;
      const duration = total(intervals.map((w) => w.end - w.start));
      for (const w of intervals)
        rows.push({
          datasetId: project.datasetId!,
          origin,
          destination,
          ...w,
          source: "estimated",
          purpose: "private",
          kind: "outbound",
          passengers: (volume * (w.end - w.start)) / duration,
          ...(trains &&
            (flow === "inbound"
              ? { boundaryOriginTrains: trains }
              : { boundaryDestinationTrains: trains })),
        });
    }
  };
  // Reserve the explicitly counted external flows before distributing local boardings.
  for (const area of settings.outside) {
    const gate = area.stationId;
    for (const flow of ["inbound", "outbound"] as const) {
      const amount = area[flow];
      if (!amount) continue;
      const through = area.mode === "through";
      const requested = area.trains[diaId]?.[flow] ?? [];
      const trains = through
        ? passenger.filter((t) => requested.includes(t.id))
        : [];
      const eligible = through
        ? new Set(
            trains.flatMap((t) => {
              const stops = trainVisits(t);
              return (flow === "inbound" ? stops.slice(1) : stops.slice(0, -1))
                .filter(
                  (s) =>
                    s.status === "stop" &&
                    (flow === "inbound"
                      ? s.dropoffAllowed !== false && s.arrival !== undefined
                      : s.pickupAllowed !== false && s.departure !== undefined),
                )
                .flatMap((s) =>
                  flow === "inbound"
                    ? [s.stationId, ...routes.get(s.stationId)!]
                    : [
                        s.stationId,
                        ...ids.filter((id) => routes.get(id)!.has(s.stationId)),
                      ],
                );
            }),
          )
        : flow === "inbound"
          ? routes.get(gate)!
          : new Set(ids.filter((id) => routes.get(id)!.has(gate)));
      const remaining = flow === "inbound" ? alight : board;
      const candidates = ids.filter(
        (id) => id !== gate && eligible.has(id) && remaining.get(id)! > 0,
      );
      const available = total(candidates.map((id) => remaining.get(id)!));
      const applied = Math.min(amount, available);
      if (applied < amount) {
        rejected += amount - applied;
        warnings.push(
          `${area.name}（${flow === "inbound" ? "流入" : "流出"}）に ${(amount - applied).toLocaleString("ja-JP", { maximumFractionDigits: 1 })} 人の未配分があります。直通列車・接続駅・駅別人数を確認してください。`,
        );
      }
      const trainIds = through ? trains.map((t) => t.id).sort() : undefined;
      for (const id of candidates) {
        const passengers = (applied * remaining.get(id)!) / available;
        remaining.set(id, remaining.get(id)! - passengers);
        if (flow === "inbound") add(gate, id, passengers, flow, trainIds);
        else add(id, gate, passengers, flow, trainIds, area.name);
      }
    }
  }
  for (const origin of ids) {
    const amount = board.get(origin)!;
    if (!amount) continue;
    const targets = [...routes.get(origin)!].filter(
      (id) => alight.get(id)! > 0 && weight(id) > 0,
    );
    const attraction = total(targets.map((id) => alight.get(id)! * weight(id)));
    if (attraction === 0) {
      rejected += amount;
      warnings.push(
        `${project.stations.find((s) => s.id === origin)!.name}：行先候補がない ${amount.toLocaleString("ja-JP", { maximumFractionDigits: 1 })} 人を未配分としました。`,
      );
      continue;
    }
    for (const id of targets)
      add(
        origin,
        id,
        (amount * (alight.get(id)! * weight(id))) / attraction,
        "local",
      );
  }
  return {
    rows,
    byTime,
    external,
    destinations,
    dailyBoard,
    dailyAlight,
    rejected,
    warnings,
  };
}
