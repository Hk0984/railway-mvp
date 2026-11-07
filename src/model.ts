import {
  validateTemporalState,
  validateTemporalConfig,
  type TemporalState,
  type TemporalConfig,
} from "./temporal-model";
import {
  validateClassifications,
  type ServiceClassification,
} from "./classification";
import {
  validateAssignmentConfig,
  type AssignmentConfig,
} from "./assignment-model";
/** Time: seconds from service-day 00:00. Beyond 24:00 is explicit, never wrapped. */
export type Direction = "down" | "up";
export type Purpose = "commute" | "school" | "shopping" | "private";
export interface Station {
  id: string;
  name: string;
  lineId: string;
  section: string;
  population: number;
  employment: number;
  students: number;
  attraction: number;
  railShare: number;
  transfers: string[];
}
export interface Stop {
  stationId: string;
  status: "stop" | "pass" | "none";
  arrival?: number;
  departure?: number;
  track?: string;
  /** Original timetable-row identity, distinct from the physical station ID. */
  positionId?: string;
  sourcePositionIds?: string[];
  pickupAllowed?: boolean;
  dropoffAllowed?: boolean;
}
export interface RoutePosition {
  id: string;
  stationId: string;
  name: string;
  branchCorePositionId?: string;
  tracks: string[];
  outerTerminalIds: string[];
}
export interface ExternalTerminal {
  id: string;
  boundaryStationId: string;
  name: string;
}
export interface ExternalEndpoint {
  terminalId: string;
  boundaryStationId: string;
  positionId: string;
  externalTime?: number;
  boundaryTime?: number;
  raw: string;
}
export interface StationOperation {
  positionId: string;
  phase: "before" | "after";
  code: 0 | 3 | 4 | 5 | 6;
  raw: string;
}
export interface Train {
  id: string;
  number: string;
  typeId: string;
  direction: Direction;
  stops: Stop[];
  capacity?: number;
  cancelled?: boolean;
  operations?: StationOperation[];
  externalOrigin?: ExternalEndpoint;
  externalDestination?: ExternalEndpoint;
  sourceEkiJikoku?: string;
}
export interface Timetable {
  id: string;
  name: string;
  trains: Train[];
}
export interface Demand {
  origin: string;
  destination: string;
  purpose: Purpose;
  period: string;
  passengers: number;
  source: "estimated" | "observed" | "manual";
}
export interface Parameters {
  purpose: Purpose;
  period: string;
  generation: number;
  beta: number;
  employmentWeight: number;
  studentWeight: number;
  attractionWeight: number;
}
export interface Project {
  schemaVersion: 1;
  datasetId?: string;
  serviceClasses?: ServiceClassification;
  typeCapacities?: Record<string, number>;
  assignmentConfig?: AssignmentConfig;
  temporal?: TemporalState;
  temporalConfig?: TemporalConfig;
  name: string;
  stations: Station[];
  types: { id: string; name: string }[];
  timetables: Timetable[];
  costs: Record<string, Record<string, number>>;
  parameters: Parameters;
  demands: Demand[];
  /** Optional metadata leaves initial schemaVersion 1 files valid. */
  oud2?: {
    fileType: string;
    encoding?: string;
    serviceDayStart: number;
    positions: RoutePosition[];
    links: { from: string; to: string }[];
    externalTerminals: ExternalTerminal[];
    emptyColumns: number;
    warnings: string[];
  };
}
export const defaultParameters: Parameters = {
  purpose: "commute",
  period: "朝 07:00–09:00",
  generation: 0.15,
  beta: 0.05,
  employmentWeight: 1,
  studentWeight: 0,
  attractionWeight: 0,
};
export function validateProject(value: unknown): asserts value is Project {
  const p = value as Project;
  const fail = (s: string): never => {
    throw new Error(`データ検証: ${s}`);
  };
  if (
    !p ||
    p.schemaVersion !== 1 ||
    typeof p.name !== "string" ||
    !Array.isArray(p.stations) ||
    p.stations.length < 2 ||
    !Array.isArray(p.types) ||
    !Array.isArray(p.timetables) ||
    !p.timetables.length ||
    !Array.isArray(p.demands) ||
    !p.costs ||
    !p.parameters
  )
    fail("schemaVersion=1 のプロジェクトが必要です");
  const ids = new Set<string>();
  const nonnegative = (n: unknown) =>
    typeof n === "number" && Number.isFinite(n) && n >= 0;
  for (const s of p.stations) {
    if (
      !s ||
      typeof s.id !== "string" ||
      !s.id ||
      ids.has(s.id) ||
      typeof s.name !== "string" ||
      !s.name ||
      typeof s.lineId !== "string" ||
      typeof s.section !== "string" ||
      !Array.isArray(s.transfers) ||
      s.transfers.some((x) => typeof x !== "string")
    )
      fail("駅ID・駅名・所属・乗換情報が不正です");
    ids.add(s.id);
    for (const k of [
      "population",
      "employment",
      "students",
      "attraction",
      "railShare",
    ] as const)
      if (!nonnegative(s[k])) fail(`${s.id}: ${k}`);
    if (s.railShare > 1) fail("鉄道利用率は0〜1");
  }
  for (const s of p.stations)
    if (s.transfers.some((id) => !ids.has(id))) fail("乗換駅IDが未登録です");
  if (
    p.datasetId !== undefined &&
    (typeof p.datasetId !== "string" || !p.datasetId)
  )
    fail("データセットID不正");
  if (p.temporal) validateTemporalState(p.temporal, ids);
  if (p.temporalConfig) validateTemporalConfig(p.temporalConfig);
  if (p.assignmentConfig) validateAssignmentConfig(p.assignmentConfig);
  const typeIds = new Set(p.types.map((t) => t.id));
  validateClassifications(p);
  if (
    typeIds.size !== p.types.length ||
    p.types.some((t) => !t.id || typeof t.name !== "string")
  )
    fail("種別ID不正");
  const diaIds = new Set<string>();
  const positions = new Map(p.oud2?.positions.map((x) => [x.id, x]) ?? []);
  if (p.oud2) {
    const m = p.oud2;
    if (
      !["OuDiaSecond.1.07", "OuDiaSecond.1.17"].includes(m.fileType) ||
      !nonnegative(m.serviceDayStart) ||
      m.serviceDayStart >= 86400 ||
      !Number.isInteger(m.emptyColumns) ||
      m.emptyColumns < 0 ||
      !Array.isArray(m.warnings) ||
      m.warnings.some((w) => typeof w !== "string")
    )
      fail("OuDia2ndメタデータ不正");
    if (positions.size !== m.positions.length) fail("時刻表行IDの重複");
    const externalIds = new Set(m.externalTerminals.map((x) => x.id));
    if (externalIds.size !== m.externalTerminals.length)
      fail("路線外駅IDの重複");
    for (const t of m.externalTerminals)
      if (
        !ids.has(t.boundaryStationId) ||
        typeof t.name !== "string" ||
        !t.name
      )
        fail("路線外駅定義不正");
    for (const x of m.positions) {
      if (
        !x.id ||
        !ids.has(x.stationId) ||
        typeof x.name !== "string" ||
        !Array.isArray(x.tracks) ||
        x.tracks.some((t) => typeof t !== "string") ||
        !Array.isArray(x.outerTerminalIds) ||
        x.outerTerminalIds.some((id) => !externalIds.has(id))
      )
        fail("時刻表行参照不正");
      if (
        x.branchCorePositionId &&
        (!positions.has(x.branchCorePositionId) ||
          positions.get(x.branchCorePositionId)!.stationId !== x.stationId)
      )
        fail("分岐駅参照不正");
    }
    for (const x of m.links)
      if (!ids.has(x.from) || !ids.has(x.to) || x.from === x.to)
        fail("路線リンク参照不正");
  }
  for (const d of p.timetables) {
    if (
      !d.id ||
      diaIds.has(d.id) ||
      typeof d.name !== "string" ||
      !Array.isArray(d.trains)
    )
      fail("ダイヤ不正");
    diaIds.add(d.id);
    const trainIds = new Set<string>();
    for (const t of d.trains) {
      if (
        !t.id ||
        trainIds.has(t.id) ||
        typeof t.number !== "string" ||
        !typeIds.has(t.typeId) ||
        !["up", "down"].includes(t.direction) ||
        !Array.isArray(t.stops)
      )
        fail("列車ID・種別・方向不正");
      trainIds.add(t.id);
      if (t.cancelled !== undefined && typeof t.cancelled !== "boolean")
        fail("運休フラグ不正");
      for (const endpoint of [t.externalOrigin, t.externalDestination])
        if (endpoint) {
          const terminal = p.oud2?.externalTerminals.find(
            (x) => x.id === endpoint.terminalId,
          );
          if (
            !terminal ||
            terminal.boundaryStationId !== endpoint.boundaryStationId ||
            positions.get(endpoint.positionId)?.stationId !==
              endpoint.boundaryStationId ||
            typeof endpoint.raw !== "string"
          )
            fail("路線外発着参照不正");
          for (const v of [endpoint.externalTime, endpoint.boundaryTime])
            if (v !== undefined && !nonnegative(v)) fail("路線外発着時刻不正");
        }
      if (
        t.externalOrigin?.externalTime !== undefined &&
        t.externalOrigin.boundaryTime !== undefined &&
        t.externalOrigin.externalTime > t.externalOrigin.boundaryTime
      )
        fail("路線外始発の時刻逆転");
      if (
        t.externalDestination?.externalTime !== undefined &&
        t.externalDestination.boundaryTime !== undefined &&
        t.externalDestination.boundaryTime > t.externalDestination.externalTime
      )
        fail("路線外終着の時刻逆転");
      for (const op of t.operations ?? [])
        if (
          !positions.has(op.positionId) ||
          ![0, 3, 4, 5, 6].includes(op.code) ||
          !["before", "after"].includes(op.phase) ||
          typeof op.raw !== "string"
        )
          fail("駅作業参照不正");
      if (
        t.capacity !== undefined &&
        (!nonnegative(t.capacity) || t.capacity === 0)
      )
        fail("定員不正");
      let last = -1;
      const seen = new Set<string>();
      for (const s of t.stops) {
        if (
          s.sourcePositionIds &&
          (!Array.isArray(s.sourcePositionIds) ||
            s.sourcePositionIds.some(
              (id) => positions.get(id)?.stationId !== s.stationId,
            ))
        )
          fail("元時刻表行の参照不正");
        for (const flag of [s.pickupAllowed, s.dropoffAllowed])
          if (flag !== undefined && typeof flag !== "boolean")
            fail("乗降可否フラグ不正");
        if (
          !ids.has(s.stationId) ||
          seen.has(s.positionId ?? s.stationId) ||
          (s.positionId !== undefined &&
            positions.get(s.positionId)?.stationId !== s.stationId) ||
          !["stop", "pass", "none"].includes(s.status)
        )
          fail("列車の駅参照不正");
        seen.add(s.positionId ?? s.stationId);
        for (const v of [s.arrival, s.departure])
          if (v !== undefined) {
            if (!nonnegative(v) || v < last)
              fail(
                "時刻は運行順に単調増加する秒数が必要です。日跨ぎは24時以降で指定",
              );
            last = v;
          }
        if (
          s.status === "none" &&
          (s.arrival !== undefined || s.departure !== undefined)
        )
          fail("運行なし駅に時刻があります");
      }
    }
  }
  for (const [o, row] of Object.entries(p.costs)) {
    if (!ids.has(o) || !row || typeof row !== "object")
      fail("所要時間行列の発駅ID不正");
    for (const [d, v] of Object.entries(row))
      if (!ids.has(d) || !nonnegative(v))
        fail("所要時間行列は登録駅IDと非負の分数が必要です");
  }
  const q = p.parameters;
  if (
    !["commute", "school", "shopping", "private"].includes(q.purpose) ||
    typeof q.period !== "string" ||
    !q.period
  )
    fail("需要目的・時間帯不正");
  for (const k of [
    "generation",
    "beta",
    "employmentWeight",
    "studentWeight",
    "attractionWeight",
  ] as const)
    if (!nonnegative(q[k])) fail(`需要係数 ${k} 不正`);
  for (const d of p.demands)
    if (
      !ids.has(d.origin) ||
      !ids.has(d.destination) ||
      !["commute", "school", "shopping", "private"].includes(d.purpose) ||
      !["estimated", "observed", "manual"].includes(d.source) ||
      typeof d.period !== "string" ||
      !nonnegative(d.passengers) ||
      (d.origin === d.destination && d.passengers !== 0)
    )
      fail("OD需要不正（同一駅ODは0）");
}
