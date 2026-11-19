import "./renewal.css";
import { clock, trainVisits } from "./analysis";
import {
  defaultAssignmentConfig,
  type DiagramAssignment,
} from "./assignment-model";
import { transportCapacity } from "./capacity-model";
import { classificationCounts, isPassengerTrain } from "./classification";
import { diagramPage, mountDiagram } from "./diagram-ui";
import { download } from "./io";
import {
  arrivalDirections,
  arrivalHours,
  defaultLineDemand,
  estimateLineDemand,
  periods,
  serviceDay,
  type OutsideArea,
} from "./line-demand";
import { validateProject, type Project } from "./model";
import { parseOud2 } from "./oud2";
import { decodeOud2 } from "./oud2-text";
import { cachedRoutingIndex } from "./routing-cache";
import { searchJourneys } from "./routing";
import { journeyCards, routeBody, type RouteForm } from "./renewal-route";
import {
  applyTrainSettings,
  areaCard,
  readDemand,
  settingsBody,
  updateArrivalTotals,
  updateDemandTiming,
} from "./renewal-settings";
import { sampleProject } from "./sample";
import { loadProject, saveProject } from "./storage";
import { escapeHtml as e, numberText as n, parseClock } from "./ui-utils";
import { validateWorkspace, type Workspace } from "./workspace";

const pages = {
  route: "乗換案内",
  diagram: "混雑ダイヤ図",
  settings: "データ設定",
} as const;
type Page = keyof typeof pages;
const app = document.querySelector<HTMLElement>("#app")!;
function demo() {
  const p = sampleProject();
  p.lineDemand = defaultLineDemand(true);
  return p;
}

let project = demo(),
  diaId = project.timetables[0].id;
let page: Page =
  location.hash.slice(1) === "diagram"
    ? "diagram"
    : location.hash.slice(1) === "settings"
      ? "settings"
      : "route";
let route: RouteForm = {
  origin: project.stations[0].id,
  destination: project.stations.at(-1)!.id,
  time: "07:30",
  mode: "depart",
};
let searched = true;
let notice = "",
  error = "",
  assignmentStatus = "",
  storageStatus = "",
  dirty = false;
let saveTicket = 0;
let result: DiagramAssignment | undefined, worker: Worker | undefined;
let disposeDiagram: (() => void) | undefined;
let demand: ReturnType<typeof estimateLineDemand> | undefined;
let loading = false;
const dia = () => project.timetables.find((d) => d.id === diaId)!;
const selection = () => ({
  datasetId: project.datasetId!,
  project,
  timetableId: diaId,
  passengerOnly: true,
});
const estimate = () => (demand ??= estimateLineDemand(project, diaId));
const legacy = () =>
  !project.lineDemand?.destinationArrival?.enabled &&
  !Object.keys(project.lineDemand?.counts ?? {}).length &&
  !project.lineDemand?.outside.length &&
  !!project.temporal?.slots.length;

function render() {
  disposeDiagram?.();
  disposeDiagram = undefined;
  const timetable = dia();
  const sample = project.datasetId === "sample-mirai";
  app.innerHTML = `
    <header class="app-header">
      <div class="app-header-inner">
        <a class="brand" href="#route"><span class="brand-icon" aria-hidden="true"><i></i><i></i><i></i></span>Railway Lab</a>
        <nav aria-label="メインメニュー">${Object.entries(pages)
          .map(
            ([id, label]) =>
              `<a href="#${id}" ${id === page ? 'aria-current="page"' : ""}>${label}</a>`,
          )
          .join("")}</nav>
        <button class="dataset" data-action="settings" type="button"><span class="dataset-light" aria-hidden="true"></span><span>${e(project.name)}</span></button>
      </div>
    </header>
    <main id="workspace">
      <header class="page-heading"><div>
        <p class="context">${e(project.name)} <span aria-hidden="true">/</span> ${e(timetable.name)}${sample ? " · 架空サンプル" : ""}</p>
        <h1>${pages[page]}</h1>
      </div>${
        page === "diagram"
          ? `<div class="heading-actions">
        <span id="assignment-progress" role="status">${e(assignmentStatus)}</span>
        <button type="button" class="primary" data-action="${worker ? "cancel" : "calculate"}">${worker ? "計算を中止" : result ? "混雑を再計算" : "混雑を計算"}</button>
      </div>`
          : ""
      }</header>
      <div id="messages">${messages()}</div>
      ${
        page === "route"
          ? routeBody(project, route)
          : page === "diagram"
            ? diagramPage() + demandPreview()
            : settingsBody(project, timetable)
      }
    </main>`;
  if (page === "route" && searched) search();
  if (page === "diagram")
    disposeDiagram = mountDiagram(
      app.querySelector("#train-diagram")!,
      project,
      diaId,
      result,
      true,
    );
  refreshSaveBar();
}

function messages() {
  return `${error ? `<p class="message error" role="alert">${e(error)}</p>` : ""}
    ${notice ? `<p class="message" role="status">${e(notice)}</p>` : ""}
    <p id="storage-status" class="message error" role="status" ${storageStatus ? "" : "hidden"}>${e(storageStatus)}</p>`;
}
function refreshMessages() {
  const box = document.querySelector("#messages");
  if (box) box.innerHTML = messages();
}
function fail(reason: unknown) {
  error = reason instanceof Error ? reason.message : String(reason);
  notice = "";
  refreshMessages();
}
function refreshSaveBar() {
  const el = document.querySelector("#form-state");
  if (el) el.textContent = dirty ? "未保存の変更があります" : "";
}

function demandPreview() {
  try {
    const {
      dailyBoard,
      dailyAlight,
      byTime,
      byArrival,
      external,
      destinations,
      rejected,
      warnings,
    } = estimate();
    const totals = classificationCounts(project, diaId);
    const missing = dia().trains.filter(
      (t) =>
        isPassengerTrain(project, diaId, t) &&
        transportCapacity(project, diaId, t.id) === null,
    ).length;
    const names = new Map(project.stations.map((s) => [s.id, s.name]));
    const dominant = [...destinations]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, amount]) => `${e(names.get(name) ?? name)} ${n(amount)}人`)
      .join(" · ");
    const assigned = result?.diagnostics.hourlyArrivals;
    const timeSummary = byArrival
      ? `<div class="table-scroll arrival-hour-grid"><table>
        <thead><tr><th scope="col">目的地への到着時刻</th><th scope="col">上り需要（人）</th><th scope="col">下り需要（人）</th>${assigned ? '<th scope="col">上り配分（人）</th><th scope="col">下り配分（人）</th>' : ""}</tr></thead>
        <tbody>${arrivalHours(project)
          .map(
            ({ index, label }) =>
              `<tr><th scope="row">${label}</th>${arrivalDirections.map((dir) => `<td>${n(byArrival[dir][index])}</td>`).join("")}${assigned ? arrivalDirections.map((dir) => `<td>${n(assigned[dir][index])}</td>`).join("") : ""}</tr>`,
          )
          .join("")}</tbody>
      </table></div>`
      : `<div class="preview-periods">${periods.map((period, i) => `<div><span>${period.label}</span><strong>${n(byTime[i])}<small> 人</small></strong></div>`).join("")}</div>`;
    return `<details id="demand-preview" class="surface preview" ${!result ? "open" : ""}>
      <summary>需要と計算条件</summary>
      ${
        legacy()
          ? "<p>以前保存した時間帯別ODを使用します。駅利用者数を登録すると新しい推計に切り替わります。</p>"
          : `
        ${timeSummary}
        <p>路線外の配分対象　流入 ${n(external.inbound)}人・流出 ${n(external.outbound)}人</p>
        ${dominant ? `<p>主な行先　${dominant}</p>` : ""}
        ${Math.abs(dailyBoard - dailyAlight) > 0.01 ? `<p class="muted">内数調整後の駅別合計　乗車 ${n(dailyBoard)}人・降車 ${n(dailyAlight)}人。降車人数は行先の重みに使います。</p>` : ""}
        ${rejected > 0 ? `<p>OD作成時の未配分 ${n(rejected)}人</p><ul>${warnings.map((v) => `<li>${e(v)}</li>`).join("")}</ul>` : ""}`
      }
      <p class="muted">営業 ${n(totals.passenger, 0)}本／要確認 ${n(totals.review, 0)}本／輸送定員が未登録の営業列車 ${n(missing, 0)}本</p>
      ${result ? `<p>列車へ配分 ${n(result.totals.assigned)}人・時刻条件による未配分 ${n(result.totals.unassigned)}人</p>` : ""}
      <button type="button" data-action="settings">データ設定を開く</button>
    </details>`;
  } catch (err) {
    return `<p class="message error">${e((err as Error).message)}</p>`;
  }
}

function search() {
  const target = document.querySelector<HTMLElement>("#journey-results")!;
  try {
    const index = cachedRoutingIndex([selection()]);
    const time = parseClock(route.time);
    if (!index.trips.size)
      throw new Error(
        "検索対象の営業列車がありません。データ設定で営業区分を確認してください。",
      );
    const { journeys, reason, displayLimited } = searchJourneys(index, {
      origin: { datasetId: project.datasetId!, stationId: route.origin },
      destination: {
        datasetId: project.datasetId!,
        stationId: route.destination,
      },
      mode: route.mode,
      time,
      maxTransfers: 3,
      minimumTransferSeconds: 120,
      directOnly: false,
      sort: "arrival",
      limit: 5,
    });
    target.innerHTML = journeys.length
      ? `<h2 class="result-heading">経路候補 <small>${journeys.length}件${displayLimited ? "を表示" : ""}</small></h2>${journeyCards(project, journeys)}`
      : `<p class="message">${e(reason)}</p>`;
  } catch (err) {
    target.innerHTML = `<p class="message error" role="alert">${e((err as Error).message)}</p>`;
  }
}
function defaultRoute() {
  const t = project.oud2?.serviceDayStart ?? 0;
  const earliest = dia().trains.reduce(
    (min, train) =>
      Math.min(min, ...trainVisits(train).map((s) => s.departure ?? Infinity)),
    Infinity,
  );
  return {
    origin: project.stations[0].id,
    destination: project.stations.at(-1)!.id,
    time: clock(Number.isFinite(earliest) ? earliest : t),
    mode: "depart" as const,
  };
}
function readRoute(form: HTMLFormElement): RouteForm {
  const data = new FormData(form);
  return {
    origin: String(data.get("origin")),
    destination: String(data.get("destination")),
    time: String(data.get("time")).trim(),
    mode: data.get("mode") === "arrive" ? "arrive" : "depart",
  };
}

function resetResult() {
  worker?.terminate();
  worker = undefined;
  result = undefined;
  demand = undefined;
  assignmentStatus = "";
}
function persist() {
  const ticket = ++saveTicket;
  storageStatus = "";
  void saveProject(project).catch(() => {
    if (ticket !== saveTicket) return;
    storageStatus =
      "ブラウザに保存できませんでした。必要な場合は設定をJSONで保存してください。";
    refreshMessages();
  });
}
function setProject(p: Project, save = true) {
  validateProject(p);
  p.datasetId ??= crypto.randomUUID();
  project = p;
  diaId = p.timetables[0].id;
  route = defaultRoute();
  searched = false;
  dirty = false;
  resetResult();
  if (save) persist();
}
function hasUnsavedChanges() {
  return dirty && !window.confirm("未保存のデータ設定を破棄しますか？");
}
function go(next: Page) {
  if (next === page || (page === "settings" && hasUnsavedChanges())) return;
  dirty = false;
  error = "";
  notice = "";
  page = next;
  history.replaceState(null, "", "#" + next);
  render();
  window.scrollTo(0, 0);
}

async function openFile(input: HTMLInputElement) {
  const file = input.files?.[0];
  if (!file || loading) return;
  if (hasUnsavedChanges()) {
    input.value = "";
    return;
  }
  const encoding =
    document.querySelector<HTMLSelectElement>("#encoding")!.value;
  loading = true;
  try {
    if (file.size > 20 * 1024 * 1024) throw new Error("読み込み上限は20MBです");
    let next: Project;
    if (/\.json$/i.test(file.name)) {
      const data: Project | Workspace = JSON.parse(await file.text());
      if ("projects" in data) {
        validateWorkspace(data);
        next = data.projects.find((p) => p.datasetId === data.activeDatasetId)!;
      } else next = data;
    } else {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const decoded = decodeOud2(bytes, encoding);
      next = parseOud2(decoded.text).project;
      next.oud2!.encoding = decoded.encoding;
    }
    setProject(next);
    page = "settings";
    notice = `${file.name} を読み込みました`;
    error = "";
    render();
  } catch (err) {
    fail(err);
    input.value = "";
  } finally {
    loading = false;
  }
}

function calculate() {
  if (worker) return;
  const totals = classificationCounts(project, diaId);
  if (!totals.passenger)
    throw new Error("データ設定で営業列車を指定してください。");
  const plan = estimate();
  const old = legacy();
  const input = old
    ? project.temporal!.slots.map((row) => ({
        ...row,
        datasetId: project.datasetId!,
      }))
    : plan.rows;
  if (!input.some((row) => row.passengers > 0))
    throw new Error(
      "配分できる需要がありません。駅の乗車・降車人数と路線外方面の設定を確認してください。",
    );
  const window = serviceDay(project);
  if (old)
    for (const row of input) {
      window.start = Math.min(window.start, row.start);
      window.end = Math.max(window.end, row.end);
    }
  const config = { ...defaultAssignmentConfig(), ...window };
  const { analytics, temporal, temporalConfig, lineDemand, ...assignProject } =
    project;
  const current = new Worker(
    new URL("./assignment-worker.ts", import.meta.url),
    { type: "module" },
  );
  worker = current;
  result = undefined;
  assignmentStatus = "計算中…";
  error = "";
  current.onmessage = ({ data }) => {
    if (worker !== current) return;
    if (data.type === "progress") {
      assignmentStatus = `配分中 ${n(data.done, 0)} / ${n(data.total, 0)}`;
      const status = document.querySelector("#assignment-progress");
      if (status) status.textContent = assignmentStatus;
      return;
    }
    current.terminate();
    worker = undefined;
    if (data.type === "error") {
      error = data.message;
      assignmentStatus = "";
    } else {
      result = data.results[0];
      assignmentStatus = "計算完了";
    }
    if (page === "diagram") render();
    else refreshMessages();
  };
  current.onerror = () => {
    if (worker !== current) return;
    resetResult();
    error = "旅客配分を実行できませんでした。もう一度お試しください。";
    if (page === "diagram") render();
    else refreshMessages();
  };
  current.postMessage({
    selections: [{ ...selection(), project: assignProject }],
    links: [],
    input,
    config,
    compare: false,
    forDiagram: true,
  });
  render();
}

app.addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.target as HTMLFormElement;
  if (form.id === "journey-form") {
    route = readRoute(form);
    searched = true;
    search();
  } else if (form.id === "settings-form") {
    try {
      const next = structuredClone(project);
      next.lineDemand = readDemand(form, project, dia());
      applyTrainSettings(
        form,
        next,
        next.timetables.find((d) => d.id === diaId)!,
      );
      validateProject(next);
      const nextDemand = estimateLineDemand(next, diaId);
      project = next;
      resetResult();
      demand = nextDemand;
      searched = false;
      dirty = false;
      notice = "設定を保存しました";
      error = "";
      persist();
      refreshMessages();
      refreshSaveBar();
    } catch (err) {
      fail(err);
    }
  }
});
app.addEventListener("input", (event) => {
  const input = event.target as HTMLInputElement;
  if (input.id === "train-filter") {
    const query = input.value.trim().toLowerCase();
    for (const row of Array.from(
      app.querySelectorAll<HTMLElement>("[data-train-row]"),
    ))
      row.hidden = !row.dataset.trainRow!.toLowerCase().includes(query);
  } else if (input.closest("#settings-form")) {
    dirty = true;
    if (input.name.startsWith("arr-hour-")) updateArrivalTotals(input.form!);
    refreshSaveBar();
  } else if (input.closest("#journey-form")) {
    route = readRoute(input.closest("form")!);
    searched = false;
    document.querySelector("#journey-results")?.replaceChildren();
  }
});
app.addEventListener("change", (event) => {
  const input = event.target as HTMLInputElement;
  if (input.id === "open-file") void openFile(input);
  if (input.id === "active-dia") {
    if (hasUnsavedChanges()) {
      input.value = diaId;
      return;
    }
    diaId = input.value;
    dirty = false;
    searched = false;
    resetResult();
    render();
  }
  const form = input.closest<HTMLFormElement>("#settings-form");
  if (!form) return;
  if (input.name === "demand-time-mode") updateDemandTiming(form);
  if (input.name.startsWith("override-")) {
    const fields = form.querySelector<HTMLElement>(
      `[data-override="${input.name.slice(9)}"]`,
    );
    if (fields) fields.hidden = !input.checked;
  }
  const node = input.closest<HTMLElement>("[data-area]");
  if (node && input.name === "area-mode")
    node.querySelector<HTMLElement>(".through-fields")!.hidden =
      input.value !== "through";
  if (node && input.name === "area-station") {
    const i = Array.from(form.querySelectorAll("[data-area]")).indexOf(node);
    const area = readDemand(form, project, dia()).outside[i];
    area.trains = {};
    node.outerHTML = areaCard(project, dia(), area, i);
    form
      .querySelectorAll("[data-area]")
      [i].querySelector<HTMLElement>('[name="area-station"]')!
      .focus();
  }
});
app.addEventListener("click", (event) => {
  const el = (event.target as HTMLElement).closest<HTMLElement>(
    "a[href^='#'], [data-action], [data-remove-area]",
  );
  if (!el) return;
  if (el instanceof HTMLAnchorElement) {
    event.preventDefault();
    const id = el.hash.slice(1);
    if (Object.hasOwn(pages, id)) go(id as Page);
    return;
  }
  try {
    const form = el.closest<HTMLFormElement>("#settings-form");
    if (el.hasAttribute("data-remove-area")) {
      el.closest("[data-area]")?.remove();
      dirty = true;
      refreshSaveBar();
    }
    switch (el.dataset.action) {
      case "settings":
        go("settings");
        break;
      case "swap": {
        const f = el.closest<HTMLFormElement>("form")!;
        route = readRoute(f);
        [route.origin, route.destination] = [route.destination, route.origin];
        (f.elements.namedItem("origin") as HTMLSelectElement).value =
          route.origin;
        (f.elements.namedItem("destination") as HTMLSelectElement).value =
          route.destination;
        if (searched) search();
        break;
      }
      case "export": {
        if (dirty)
          throw new Error("JSONに出力する前に変更を保存してください。");
        download(
          "railway-lab.json",
          JSON.stringify(project, null, 2),
          "application/json",
        );
        break;
      }
      case "sample": {
        if (hasUnsavedChanges()) break;
        setProject(demo());
        notice = "架空サンプルを開きました";
        error = "";
        render();
        break;
      }
      case "add-area": {
        const area: OutsideArea = {
          id: crypto.randomUUID(),
          name: "",
          stationId: project.stations[0].id,
          inbound: 0,
          outbound: 0,
          included: false,
          mode: "transfer",
          trains: {},
        };
        const container = form!.querySelector("#outside-areas")!;
        container.insertAdjacentHTML(
          "beforeend",
          areaCard(project, dia(), area, container.children.length),
        );
        container.lastElementChild
          ?.querySelector<HTMLInputElement>('[name="area-name"]')
          ?.focus();
        dirty = true;
        refreshSaveBar();
        break;
      }
      case "all-passenger": {
        for (const select of Array.from(
          form!.querySelectorAll<HTMLSelectElement>('select[name^="class"]'),
        ))
          if (select.value === "review") select.value = "passenger";
        dirty = true;
        refreshSaveBar();
        break;
      }
      case "calculate":
        calculate();
        break;
      case "cancel":
        resetResult();
        render();
        break;
    }
  } catch (err) {
    fail(err);
  }
});

try {
  const stored = await loadProject();
  if (stored) {
    if (
      stored.datasetId === "sample-mirai" &&
      !stored.lineDemand &&
      !stored.temporal
    )
      stored.lineDemand = defaultLineDemand(true);
    setProject(stored, false);
  }
} catch {
  error =
    "保存したプロジェクトを開けませんでした。架空サンプルを表示しています。";
}
render();
