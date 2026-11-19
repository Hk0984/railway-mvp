import { clock } from "./analysis";
import type { Project } from "./model";
import { legPresentation } from "./route-presentation";
import { escapeHtml as e, numberText as n } from "./ui-utils";
import type { Journey } from "./routing-model";
import { options } from "./renewal-settings";

export interface RouteForm {
  origin: string;
  destination: string;
  time: string;
  mode: "depart" | "arrive";
}

export function lineRibbon(p: Project) {
  return `<div class="line-ribbon" aria-label="駅の並び（登録順）"><ol>${p.stations
    .map((s) => `<li><span>${e(s.name)}</span></li>`)
    .join("")}</ol></div>`;
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
    <div class="route-content">
      <section id="journey-results" aria-live="polite"></section>
      <aside class="surface line-overview"><h2>路線の駅</h2>${lineRibbon(p)}</aside>
    </div>`;
}

export function journeyCards(project: Project, journeys: Journey[]) {
  const names = new Map(project.stations.map((s) => [s.id, s.name]));
  return journeys
    .map(
      (j, index) =>
        `<details class="journey-card" ${index === 0 ? "open" : ""}>
      <summary>
        <span class="journey-time">${clock(j.departure)} <span aria-hidden="true">→</span> ${clock(j.arrival)}</span>
        <span class="journey-meta">${n(j.elapsedSeconds / 60)}分 <span>·</span> ${j.transferCount ? "乗換 " + j.transferCount + "回" : "直通"}</span>
      </summary>
      <ol class="journey-legs">${j.legs
        .map((leg, i) => {
          const view = legPresentation(project, leg);
          return `<li>
          ${i > 0 ? `<p class="transfer-note">乗換待ち ${n(j.transfers[i - 1].waitingSeconds / 60)}分</p>` : ""}
          <div class="journey-stop"><time>${clock(leg.departure)}</time><strong>${e(names.get(leg.origin.stationId))}</strong>${view.departureTrack ? `<small>${e(view.departureTrack)}</small>` : ""}</div>
          <p class="journey-train">${e(leg.typeName)} <span>${e(view.destination)} 行</span>${leg.trainNumber ? ` <small>${e(leg.trainNumber)}</small>` : ""}</p>
          <div class="journey-stop"><time>${clock(leg.arrival)}</time><strong>${e(names.get(leg.destination.stationId))}</strong>${view.arrivalTrack ? `<small>${e(view.arrivalTrack)}</small>` : ""}</div>
        </li>`;
        })
        .join("")}</ol>
    </details>`,
    )
    .join("");
}
