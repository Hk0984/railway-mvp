import { clock } from "./analysis";
import type { DiagramAssignment } from "./assignment-model";
import {
  crowdingBand,
  crowdingColors,
  crowdingLabels,
  crowdingLimits,
  crowdingRange,
  diagramTrains,
} from "./diagram-model";
import type { Project, Stop } from "./model";
import { legPresentation } from "./route-presentation";
import { escapeHtml as e, numberText as n } from "./ui-utils";
import type { Journey, JourneyLeg } from "./routing-model";
import { options } from "./renewal-settings";
import { defaultTrainTypeColor, trainTypeColors } from "./train-type-colors";

export interface RouteForm {
  origin: string;
  destination: string;
  time: string;
  mode: "depart" | "arrive";
}

export function routeBody(p: Project, q: RouteForm) {
  return `
    <section class="surface route-search">
      <form id="journey-form">
        <div class="station-pair">
          <label>出発駅<select name="origin">${options(p.stations, q.origin)}</select></label>
          <button type="button" class="swap" data-action="swap" aria-label="出発駅と到着駅を入れ替える">⇄</button>
          <label>到着駅<select name="destination">${options(p.stations, q.destination)}</select></label>
        </div>
        <div class="search-options">
          <label>時刻指定<select name="mode">${options(
            [
              { id: "depart", name: "出発" },
              { id: "arrive", name: "到着" },
            ],
            q.mode,
          )}</select></label>
          <label>時刻<input name="time" aria-describedby="overnight" value="${e(q.time)}" placeholder="07:30" autocomplete="off" required></label>
          <button type="submit" class="primary">経路を検索</button>
        </div>
        <p id="overnight" class="muted">運行日の翌0:30は「24:30」と入力します。</p>
      </form>
    </section>
    <section id="journey-results" class="route-content" aria-live="polite"></section>`;
}

type KnownRun = { toIndex: number; percent: number };
type JourneyCall = Pick<Stop, "stationId" | "arrival" | "departure"> & {
  index: number;
  platform?: string | null;
};
const minuteClock = (seconds: number) => clock(Math.floor(seconds / 60) * 60);

function intervalPercent(
  runs: ReadonlyMap<number, KnownRun> | undefined,
  from: number,
  to: number,
) {
  if (!runs || from >= to) return null;
  // A scheduled pass time can divide one pair of stops into several diagram runs.
  let peak = 0;
  while (from < to) {
    const run = runs.get(from);
    if (!run || run.toIndex > to) return null;
    peak = Math.max(peak, run.percent);
    from = run.toIndex;
  }
  return peak;
}

function intervalBadge(percent: number | null, from: string, to: string) {
  const band = crowdingBand(percent, crowdingLimits);
  return `<span class="journey-crowding"${band >= 0 ? ` style="--crowding-color:${crowdingColors[band]}" data-band="${band}"` : ""}>
    <span class="journey-sr-only">${e(from)}から${e(to)}の混雑は</span>
    ${band < 0 ? "混雑 未算出" : `${crowdingLabels[band]} <strong>${n(percent)}%</strong>`}</span>`;
}

function timetableStops(
  leg: JourneyLeg,
  view: ReturnType<typeof legPresentation>,
  station: (id: string) => string,
  runs?: ReadonlyMap<number, KnownRun>,
) {
  const calls: JourneyCall[] = [
    {
      stationId: leg.origin.stationId,
      departure: leg.departure,
      index: leg.boardIndex,
      platform: view.departureTrack,
    },
    ...leg.stops
      .slice(1, -1)
      .flatMap((stop, i) =>
        stop.status === "stop"
          ? [{ ...stop, index: leg.boardIndex + i + 1 }]
          : [],
      ),
    {
      stationId: leg.destination.stationId,
      arrival: leg.arrival,
      index: leg.alightIndex,
      platform: view.arrivalTrack,
    },
  ];
  return `<ol class="journey-timeline" aria-label="停車駅と駅間混雑">${calls
    .map((call, i) => {
      const name = station(call.stationId);
      const previous = calls[i - 1];
      const { arrival, departure } = call;
      const time = departure ?? arrival;
      const timeText =
        arrival !== undefined &&
        departure !== undefined &&
        arrival !== departure
          ? `<time>${minuteClock(arrival)}</time>着 · <time>${minuteClock(departure)}</time>発`
          : time === undefined
            ? "時刻未記載"
            : `<time>${minuteClock(time)}</time>${departure === undefined ? "着" : "発"}`;
      return `<li>${previous ? `<div class="journey-interval">${intervalBadge(intervalPercent(runs, previous.index, call.index), station(previous.stationId), name)}</div>` : ""}
      <div class="journey-stop${i === 0 || i === calls.length - 1 ? " journey-endpoint" : ""}"><span class="journey-stop-name">${e(name)}</span><span class="journey-stop-time">${timeText}</span>${call.platform ? `<small>${e(call.platform)}</small>` : ""}</div></li>`;
    })
    .join("")}</ol>`;
}

export function journeyCards(
  project: Project,
  diaId: string,
  journeys: Journey[],
  result?: DiagramAssignment,
  selected = 0,
) {
  const names = new Map(project.stations.map((s) => [s.id, s.name]));
  const colors = trainTypeColors(project.types);
  const station = (id: string) => names.get(id) ?? id;
  const byTrain = new Map<string, Map<number, KnownRun>>();
  if (result) {
    const ids = new Set(
      journeys.flatMap((journey) => journey.legs.map((leg) => leg.trainId)),
    );
    for (const service of diagramTrains(project, diaId, result, ids)) {
      const runs = new Map<number, KnownRun>();
      for (const segment of service.segments) {
        if (segment.kind === "run" && segment.percent !== null)
          runs.set(segment.fromIndex, {
            toIndex: segment.toIndex,
            percent: segment.percent,
          });
      }
      byTrain.set(service.train.id, runs);
    }
  }
  const overview = `<div class="journey-options" role="group" aria-label="経路候補の比較">${journeys
    .map(
      (
        j,
        index,
      ) => `<button type="button" class="journey-option" data-action="journey-detail" data-journey-index="${index}" aria-pressed="${index === selected}" aria-controls="journey-detail-${index}">
      <span class="journey-time">${minuteClock(j.departure)} <span aria-hidden="true">→</span> ${minuteClock(j.arrival)}</span>
      <span class="journey-meta">${n(j.elapsedSeconds / 60)}分 <span>·</span> ${j.transferCount ? "乗換 " + j.transferCount + "回" : "直通"}</span>
    </button>`,
    )
    .join("")}</div>`;
  const legend = `<details class="journey-crowding-legend"><summary>駅間混雑の目安（6段階）</summary><ul>${crowdingLabels
    .map(
      (label, i) =>
        `<li class="journey-crowding" style="--crowding-color:${crowdingColors[i]}">${crowdingRange(i, crowdingLimits)} ${label}</li>`,
    )
    .join("")}</ul></details>`;
  return (
    overview +
    legend +
    journeys
      .map(
        (j, index) =>
          `<section class="journey-card" id="journey-detail-${index}" aria-label="経路候補${index + 1}の詳細" ${index === selected ? "" : "hidden"}>
      <ol class="journey-legs">${j.legs
        .map((leg, i) => {
          const view = legPresentation(project, leg);
          const formations = view.formationCars?.length ? view.formationCars : [view.carCount];
          const formationText = formations.map(cars => cars === undefined ? "編成両数未登録" : `${n(cars, 0)}両編成`).join(" → ");
          const color =
            colors.get(leg.typeId)?.timetable ?? defaultTrainTypeColor;
          return `<li>
          ${i > 0 ? `<p class="transfer-note">乗換待ち ${n(j.transfers[i - 1].waitingSeconds / 60)}分</p>` : ""}
          <p class="journey-train"><strong class="journey-type" style="--type-color:${color}">${e(leg.typeName)}</strong> <span>${e(view.destination)} 行</span>${leg.trainNumber ? ` <small>${e(leg.trainNumber)}</small>` : ""} <small class="journey-car-count">${formationText}</small></p>
          ${timetableStops(leg, view, station, byTrain.get(leg.trainId))}
        </li>`;
        })
        .join("")}</ol>
    </section>`,
      )
      .join("")
  );
}
