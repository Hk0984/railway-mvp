import { diagramRoutes } from "./diagram-routes";
import "./diagram.css";
import { clock } from "./analysis";
import type { AssignmentResult, DiagramAssignment } from "./assignment-model";
import { capacitySpec, trainCarCount } from "./capacity-model";
import { trainInterior } from "./diagram-interior";
import { stationBoardingChart, trainChart } from "./diagram-train-chart";
import { assignmentTransfers } from "./diagram-transfers";
import {
  crowdingColors,
  crowdingLimits,
  diagramTrains,
  seatedCrowdingLimit,
  type DiagramSegment,
  type DiagramTrain,
} from "./diagram-model";
import {
  drawDiagram,
  hitLine,
  indexPlot,
  plotLeft,
  plotTop,
  rowHeight,
  type DiagramRenderSettings,
  type PlotLine,
  type VisibleLine,
} from "./diagram-render";
import type { Direction, Project } from "./model";
import { escapeHtml as e, numberText as n } from "./ui-utils";

const routeSelection = new WeakMap<Project, number>();
const storageKey = "railway-lab.diagram-haze";
const bandLabels = [
  "全員着席レベル",
  "比較的余裕あり",
  "やや混雑",
  "混雑",
  "非常に混雑",
  "極度の混雑",
];
const defaultZoom = 640;
const zoomLevels = [40, 80, 160, 320, defaultZoom];
type DisplayDirection = Direction | "all";
type DiagramSettings = DiagramRenderSettings & { direction: DisplayDirection };
const directions = { all: "上下両方向", up: "上り", down: "下り" };
const lineWidthRange = { min: 0.4, max: 4, step: 0.1 };
const defaultSettings: DiagramSettings = {
  direction: "all",
  lineWidth: 1.2,
  enabled: true,
  selectedOnly: false,
  width: 9,
  opacity: 0.55,
  limits: [...crowdingLimits],
  colors: [...crowdingColors],
};
function validLimits(limits: number[]) {
  return (
    limits.length === crowdingLimits.length &&
    limits[0] >= seatedCrowdingLimit &&
    limits.every((v, i) => Number.isFinite(v) && v > (limits[i - 1] ?? 0))
  );
}
function displayDirection(value: unknown): DisplayDirection {
  return value === "up" || value === "down" ? value : "all";
}
function validLineWidth(value: unknown): value is number {
  return (
    typeof value === "number" &&
    value >= lineWidthRange.min &&
    value <= lineWidthRange.max
  );
}
function readSettings(): DiagramSettings {
  const defaults = structuredClone(defaultSettings);
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    if (
      saved &&
      typeof saved.enabled === "boolean" &&
      typeof saved.selectedOnly === "boolean" &&
      typeof saved.width === "number" &&
      saved.width >= 3 &&
      saved.width <= 20 &&
      typeof saved.opacity === "number" &&
      saved.opacity >= 0 &&
      saved.opacity <= 0.85 &&
      Array.isArray(saved.limits) &&
      Array.isArray(saved.colors) &&
      (saved.colors.length === crowdingColors.length ||
        saved.colors.length === crowdingColors.length - 1) &&
      saved.colors.every(
        (v: unknown) => typeof v === "string" && /^#[a-f\d]{6}$/i.test(v),
      )
    )
      return {
        ...saved,
        limits: validLimits(saved.limits) ? saved.limits : defaults.limits,
        colors:
          saved.colors.length === crowdingColors.length
            ? saved.colors
            : [crowdingColors[0], ...saved.colors],
        direction: displayDirection(saved.direction),
        lineWidth: validLineWidth(saved.lineWidth)
          ? saved.lineWidth
          : defaults.lineWidth,
      };
  } catch {
    // The diagram also works when browser storage is unavailable.
  }
  return defaults;
}

export function diagramPage() {
  return '<section id="train-diagram" class="panel"></section>';
}

export function mountDiagram(
  root: HTMLElement,
  project: Project,
  diaId: string,
  result?: DiagramAssignment | AssignmentResult,
  compact = false,
) {
  const settings = readSettings();
  if (compact)
    Object.assign(settings, defaultSettings, {
      enabled: settings.enabled,
      direction: settings.direction,
      lineWidth: settings.lineWidth,
    });
  const names = new Map(project.stations.map((s) => [s.id, s.name]));
  const types = new Map(project.types.map((t, i) => [t.id, i]));
  const transfers =
    result &&
    ("allocations" in result ? assignmentTransfers(result) : result.transfers);
  const trains = diagramTrains(project, diaId, result).filter(
    (t) => t.segments.length,
  );
  const byId = new Map(trains.map((t) => [t.train.id, t]));
  const routes = diagramRoutes(project, trains);
  let routeIndex = Math.min(
    routeSelection.get(project) ?? 0,
    routes.length - 1,
  );
  let stationNames: string[] = [];
  let visibleSegments = new Set<DiagramSegment>();
  let query = indexPlot([]);
  let first = Infinity,
    last = 0;
  for (const service of trains)
    for (const segment of service.segments) {
      first = Math.min(first, segment.start);
      last = Math.max(last, segment.end);
    }
  const start = Number.isFinite(first)
    ? Math.max(0, Math.floor(first / 3600) * 3600 - 900)
    : 0;
  const end = Math.max(start + 3600, Math.ceil(last / 3600) * 3600 + 900);
  const percent = (v: number | null | undefined) =>
    v == null ? "未算出" : n(v) + "%";
  const people = (v: number | null | undefined) =>
    v == null ? "未算出" : n(v) + "人";
  const station = (id: string) => names.get(id) ?? id;
  const route = (s: DiagramSegment) =>
    station(s.from.stationId) +
    (s.from === s.to ? "" : " → " + station(s.to.stationId));

  root.innerHTML = `
    <div class="diagram-controls">
      <label><input id="diagram-enabled" type="checkbox" ${settings.enabled ? "checked" : ""}>混雑ヘイズ</label>
      ${
        compact
          ? ""
          : `<label>透明度<input id="diagram-opacity" type="range" min="0" max=".85" step=".01" value="${settings.opacity}"></label>
      <label>ぼかし幅<input id="diagram-width" type="range" min="3" max="20" value="${settings.width}"></label>
      <label>表示対象<select id="diagram-scope"><option value="all">全列車</option><option value="selected" ${settings.selectedOnly ? "selected" : ""}>選択列車のみ</option></select></label>`
      }
      ${routes.length > 1 ? `<label>表示経路<select id="diagram-route">${routes.map((r, i) => `<option value="${i}" ${i === routeIndex ? "selected" : ""}>${e(station(r[0]))} → ${e(station(r.at(-1)!))}</option>`).join("")}</select></label>` : ""}
      <label><span id="diagram-direction-label">表示方向</span><select id="diagram-direction" aria-labelledby="diagram-direction-label">${Object.entries(
        directions,
      )
        .map(
          ([value, label]) =>
            `<option value="${value}" ${value === settings.direction ? "selected" : ""}>${label}</option>`,
        )
        .join("")}</select></label>
      <label>スジ線の太さ<input id="diagram-line-width" type="range" min="${lineWidthRange.min}" max="${lineWidthRange.max}" step="${lineWidthRange.step}" value="${settings.lineWidth}" aria-valuetext="${n(settings.lineWidth)} ピクセル"><output id="diagram-line-width-value" for="diagram-line-width" aria-hidden="true">${n(settings.lineWidth)} px</output></label>
      <label>時間軸<select id="diagram-zoom">${zoomLevels.map((z) => `<option value="${z}" ${z === defaultZoom ? "selected" : ""}>${(z / defaultZoom) * 100}%</option>`).join("")}</select></label>
      ${compact ? "" : `<button data-page="9">${result ? "配分結果・条件を確認" : "旅客配分を計算"}</button>`}
    </div>
    <p class="muted">${result ? `配分推計・${result.diagnostics?.hourlyArrivals ? "希望到着時刻と所要時間" : result.config.method === "logit" ? "ロジット" : "最短所要時間"}／${result.diagnostics?.boardingLimit ? `乗車上限 ${n(result.diagnostics.boardingLimit.percent, 4)}%` : `定員制約${result.capacity ? "あり" : "なし"}`}・${result.diagnostics?.hourlyArrivals ? "目的地への到着時間帯" : "需要時間窓"} ${clock(result.config.start)}–${clock(result.config.end)}` : "配分結果なし。駅利用者数・営業区分・輸送定員を設定して計算してください。"} 駅は${routes.length > 1 ? "選択した経路順" : "登録順"}・等間隔。通過時刻を省略した駅は前後の記録時刻を結びます。停車駅の時刻が欠ける区間は破線で表示。</p>
    <div class="diagram-legend" aria-label="混雑率の凡例"></div>
    ${
      compact
        ? ""
        : `<details><summary>色としきい値を変更（段階式・アプリ独自の区分）</summary>
      <div class="diagram-legend">${bandLabels.map((label, i) => {
        const limitIndex = i - 1;
        const limit = settings.limits[limitIndex];
        return `<label>${label}<input type="color" aria-label="${label}の色" data-haze-color="${i}" value="${settings.colors[i]}">${limit === undefined ? "" : `<input type="number" min="${seatedCrowdingLimit}" step="any" aria-label="${label}の上限（%）" data-haze-limit="${limitIndex}" value="${limit}">%`}</label>`;
      }).join("")}</div>
      <p id="diagram-setting-error" role="status"></p>
    </details>`
    }
    <div class="diagram-scroll" tabindex="0" aria-label="列車ダイヤ図のスクロール領域">
      <div class="diagram-size" aria-hidden="true"></div>
      <canvas role="img" aria-label="横軸は運行日の時刻、縦軸は駅。下の列車と区間の選択から数値を確認できます。"></canvas>
    </div>
    <p id="diagram-empty" class="muted" role="status" hidden>選択した表示条件に該当する列車がありません。</p>
    <div class="diagram-controls">
      <label>列車<select id="diagram-train"><option value="">選択してください</option></select></label>
      <label>区間<select id="diagram-section" disabled><option value="">選択してください</option></select></label>
    </div>
    <div class="diagram-details">
      <section id="diagram-train-detail" aria-live="polite"><h3>列車情報</h3><p>スジをクリックするか列車を選択してください。</p></section>
      <section id="diagram-segment-detail" aria-live="polite"><h3>区間情報</h3><p>スジの区間をクリックしてください。</p></section>
    </div>`;

  const find = <T extends HTMLElement>(selector: string) =>
    root.querySelector<T>(selector)!;
  const scroll = find<HTMLDivElement>(".diagram-scroll");
  const spacer = find<HTMLDivElement>(".diagram-size");
  const canvas = find<HTMLCanvasElement>("canvas");
  const ctx = canvas.getContext("2d")!;
  let haze = document.createElement("canvas").getContext("2d")!;
  const trainSelect = find<HTMLSelectElement>("#diagram-train");
  const segmentSelect = find<HTMLSelectElement>("#diagram-section");
  const lineWidth = find<HTMLInputElement>("#diagram-line-width");
  const lineWidthValue = find<HTMLOutputElement>("#diagram-line-width-value");
  let zoom = defaultZoom,
    selected = "",
    active: DiagramSegment | undefined,
    visible: VisibleLine[] = [];
  let frame = 0;

  function showRoute() {
    const ids = routes[routeIndex];
    stationNames = ids.map(station);
    const rows = new Map(
      ids.map((id, i) => [id, plotTop + (i + 1) * rowHeight]),
    );
    const lines: PlotLine[] = [];
    const shown = [];
    for (const service of trains) {
      if (
        settings.direction !== "all" &&
        service.train.direction !== settings.direction
      )
        continue;
      let hasLine = false;
      for (const segment of service.segments) {
        const y1 = rows.get(segment.from.stationId);
        const y2 = rows.get(segment.to.stationId);
        if (
          y1 === undefined ||
          y2 === undefined ||
          segment.untimedPasses?.some((stop) => !rows.has(stop.stationId))
        )
          continue;
        hasLine = true;
        lines.push({
          segment,
          y1,
          y2,
          type: types.get(service.train.typeId) ?? 0,
        });
      }
      if (hasLine) shown.push(service.train);
    }
    visibleSegments = new Set(lines.map((line) => line.segment));
    query = indexPlot(lines);
    // The route or direction changed, so the cached haze belongs to different lines.
    haze = document.createElement("canvas").getContext("2d")!;
    trainSelect.innerHTML =
      '<option value="">選択してください</option>' +
      shown
        .map(
          (train) =>
            `<option value="${e(train.id)}">${e(train.number || train.id)} ／ ${e(project.types[types.get(train.typeId) ?? -1]?.name ?? train.typeId)} ／ ${train.direction === "up" ? "上り" : "下り"}</option>`,
        )
        .join("");
    find("#diagram-empty").hidden = shown.length > 0;
    const id = Array.from(trainSelect.options).some(
      (option) => option.value === selected,
    )
      ? selected
      : "";
    selected = "";
    segmentSelect.disabled = true;
    selectTrain(id, active && visibleSegments.has(active) ? active : undefined);
    resizePlot();
  }

  function resizePlot() {
    spacer.style.width =
      Math.ceil(plotLeft + ((end - start) / 3600) * zoom) + "px";
    const contentHeight = plotTop + (stationNames.length + 1) * rowHeight;
    spacer.style.height = contentHeight + "px";
    if (compact)
      scroll.style.setProperty(
        "--plot-content-height",
        contentHeight + 20 + "px",
      );
    redraw();
  }
  function redraw() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const width = scroll.clientWidth,
        height = scroll.clientHeight;
      if (!width || !height) return;
      const dpr = Math.min(devicePixelRatio || 1, 2);
      canvas.style.width = width + "px";
      canvas.style.height = height + "px";
      for (const layer of settings.enabled ? [ctx, haze] : [ctx]) {
        if (
          layer.canvas.width !== Math.round(width * dpr) ||
          layer.canvas.height !== Math.round(height * dpr)
        ) {
          layer.canvas.width = Math.round(width * dpr);
          layer.canvas.height = Math.round(height * dpr);
        }
        layer.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      const left = scroll.scrollLeft,
        top = scroll.scrollTop;
      const margin = settings.enabled ? settings.width : 4;
      visible = drawDiagram(
        ctx,
        haze,
        { width, height, left, top, start, pixelsPerHour: zoom },
        stationNames,
        query(
          start + ((left - margin) * 3600) / zoom,
          start + ((left + width - plotLeft + margin) * 3600) / zoom,
        ),
        settings,
        selected,
        active,
      );
    });
  }

  function showTrain(service?: DiagramTrain) {
    const detail = find("#diagram-train-detail");
    if (!service) {
      detail.innerHTML =
        "<h3>列車情報</h3><p>スジをクリックするか列車を選択してください。</p>";
      return;
    }
    const { train, segments, load } = service;
    const firstLine = segments[0],
      lastLine = segments.at(-1)!;
    const firstStop = service.visits.find(
      (s) => s.arrival !== undefined || s.departure !== undefined,
    );
    const lastStop = [...service.visits]
      .reverse()
      .find((s) => s.arrival !== undefined || s.departure !== undefined);
    const terminal = (id: string | undefined, fallback: string) =>
      project.oud2?.externalTerminals.find((t) => t.id === id)?.name ??
      station(fallback);
    const origin = terminal(
      train.externalOrigin?.terminalId,
      firstLine.from.stationId,
    );
    const destination = terminal(
      train.externalDestination?.terminalId,
      lastLine.to.stationId,
    );
    const originTime = train.externalOrigin
      ? train.externalOrigin.externalTime
      : (firstStop?.departure ?? firstLine.start);
    const destinationTime = train.externalDestination
      ? train.externalDestination.externalTime
      : (lastStop?.arrival ?? lastLine.end);
    const spec = capacitySpec(project, diaId, train.id);
    const cars = trainCarCount(project, diaId, train);
    const known = segments.filter((s) => s.percent !== null);
    const max = known.reduce<DiagramSegment | undefined>(
      (best, s) => (!best || s.percent! > best.percent! ? s : best),
      undefined,
    );
    const sectionCount = (s: DiagramSegment) =>
      (s.untimedPasses?.length ?? 0) + 1;
    const avg = known.length
      ? known.reduce((sum, s) => sum + s.percent! * sectionCount(s), 0) /
        known.reduce((sum, s) => sum + sectionCount(s), 0)
      : null;
    const type =
      project.types[types.get(train.typeId) ?? -1]?.name ?? train.typeId;
    const trainTransfers = transfers && load ? (transfers[load.key] ?? {}) : undefined;
    const chart = trainChart(service, {
      station,
      origin,
      destination,
      peak: max,
      crowdingFloor: settings.limits[0],
      transfers: trainTransfers,
    });
    const boarding = stationBoardingChart(load, station, trainTransfers);
    detail.innerHTML = `<h3>列車情報</h3><p><strong>${e(train.number || train.id)}</strong> ／ ${e(type)} ／ ${train.direction === "down" ? "下り" : "上り"}</p>
      <p>${e(origin)} ${originTime === undefined ? "時刻不明" : clock(originTime)} →
      ${e(destination)} ${destinationTime === undefined ? "時刻不明" : clock(destinationTime)}</p>
      <p>編成両数 ${cars ? n(cars, 0) + "両" : "未登録"}${spec?.vehicle ? " ／ " + e(spec.vehicle) : ""}</p>
      <p>推計延べ乗車 ${people(load?.totalBoardings)}</p>
      <p>平均混雑率 ${percent(avg)}（算出済み駅間の単純平均）</p>
      <p>最大混雑率 ${percent(max?.percent)}${max ? " ／ " + e(route(max)) : ""}</p>${chart}${boarding}`;
  }

  function showSegment(segment?: DiagramSegment) {
    const detail = find("#diagram-segment-detail");
    if (!segment) {
      detail.innerHTML =
        "<h3>区間情報</h3><p>スジの区間をクリックしてください。</p>";
      return;
    }
    const { train, load } = segment.service;
    const spec = capacitySpec(project, diaId, train.id);
    const capacity = load
      ? load.capacity
      : spec?.kind === "transport"
        ? spec.value
        : null;
    const status =
      segment.kind === "dwell"
        ? segment.from.status === "pass"
          ? "運転停車（旅客の乗降なし）"
          : "停車中（駅間の混雑率は適用しません）"
        : segment.kind === "gap"
          ? "途中の時刻欠落により未算出"
          : segment.kind === "point"
            ? "駅間なし"
            : segment.outsideWindow
              ? "計算の時間範囲外"
              : segment.passengers === null
                ? "配分結果なし・対象外"
                : segment.percent === null
                  ? "乗車人数は推計済み・輸送定員が未登録"
                  : "旅客配分による推計値";
    detail.innerHTML = `<h3>区間情報</h3><p><strong>${e(train.number || train.id)}</strong> ／ ${e(route(segment))} ／ ${clock(segment.start)}–${clock(segment.end)}</p>
      <p>推定乗車人数 ${people(segment.passengers)} ／ 輸送力 ${people(capacity)}${capacity !== null && spec?.kind === "transport" ? "（" + e(spec.basis) + "）" : ""}</p>
      <p>混雑率 ${percent(segment.percent)} ／ ${status}</p>
      ${segment.untimedPasses ? `<p class="muted">時刻の記載がない通過駅　${segment.untimedPasses.map((s) => e(station(s.stationId))).join("、")}</p>` : ""}
      ${trainInterior(segment.passengers, capacity, trainCarCount(project, diaId, train))}`;
  }

  function selectTrain(id: string, segment?: DiagramSegment) {
    if (selected !== id || segmentSelect.disabled) {
      const train = byId.get(id);
      trainSelect.value = id;
      segmentSelect.disabled = !train;
      segmentSelect.innerHTML =
        '<option value="">選択してください</option>' +
        (train?.segments
          .map((s, i) =>
            visibleSegments.has(s)
              ? `<option value="${i}">${e(route(s))} ／ ${clock(s.start)}${s.kind === "dwell" ? " 停車" : ""}</option>`
              : "",
          )
          .join("") ?? "");
      showTrain(train);
    }
    selected = id;
    active = segment;
    segmentSelect.value = segment
      ? String(segment.service.segments.indexOf(segment))
      : "";
    showSegment(segment);
    redraw();
  }

  function legend() {
    find(".diagram-legend").innerHTML = bandLabels
      .map((label, i) => {
        const high = settings.limits[i - 1];
        const range =
          i === 0 ? `${seatedCrowdingLimit}%未満`
          : i === 1 ? `${seatedCrowdingLimit}〜${high}%`
          : `${settings.limits[i - 2]}%超${high === undefined ? "" : `〜${high}%`}`;
        return `<span><span aria-hidden="true" style="color:${settings.colors[i]}">●</span> ${range} ${label}</span>`;
      })
      .join("");
  }
  legend();
  scroll.addEventListener("scroll", redraw, { passive: true });
  const observer = new ResizeObserver(redraw);
  observer.observe(scroll);
  canvas.addEventListener("click", (event) => {
    if (event.offsetX < plotLeft || event.offsetY < plotTop) return;
    const segment = hitLine(
      visible,
      event.offsetX,
      event.offsetY,
      scroll.scrollTop,
      selected,
    );
    selectTrain(segment?.service.train.id ?? "", segment);
  });
  root.addEventListener("change", (event) => {
    const target = event.target as HTMLInputElement | HTMLSelectElement;
    if (target === trainSelect) selectTrain(target.value);
    else if (target === segmentSelect) {
      const segment =
        target.value === ""
          ? undefined
          : byId.get(selected)?.segments[Number(target.value)];
      selectTrain(selected, segment);
    } else if (target.id === "diagram-route") {
      routeIndex = Number(target.value);
      routeSelection.set(project, routeIndex);
      scroll.scrollTop = 0;
      showRoute();
    } else if (target.id === "diagram-direction") {
      settings.direction = displayDirection(target.value);
      showRoute();
      saveSettings();
    } else if (target === lineWidth) {
      updateLineWidth();
      saveSettings();
    } else if (target.id === "diagram-zoom") {
      const prior = zoom;
      const left = scroll.scrollLeft;
      zoom = Number(target.value);
      resizePlot();
      scroll.scrollLeft = (left * zoom) / prior;
    } else updateSettings();
  });
  function updateSettings() {
    settings.enabled = find<HTMLInputElement>("#diagram-enabled").checked;
    if (!compact) readAdvancedSettings();
    legend();
    redraw();
    saveSettings();
  }
  function updateLineWidth() {
    const width = lineWidth.valueAsNumber;
    if (!validLineWidth(width)) return;
    settings.lineWidth = width;
    lineWidthValue.value = `${n(width)} px`;
    lineWidth.setAttribute("aria-valuetext", `${n(width)} ピクセル`);
    redraw();
  }
  function saveSettings() {
    try {
      if (compact) {
        const saved = readSettings();
        localStorage.setItem(
          storageKey,
          JSON.stringify({
            ...saved,
            enabled: settings.enabled,
            direction: settings.direction,
            lineWidth: settings.lineWidth,
          }),
        );
      } else localStorage.setItem(storageKey, JSON.stringify(settings));
    } catch {
      // Keep using the current settings for this view.
    }
  }
  function readAdvancedSettings() {
    const limits = Array.from(
      root.querySelectorAll<HTMLInputElement>("[data-haze-limit]"),
      (input) => input.valueAsNumber,
    );
    const message = find("#diagram-setting-error");
    if (validLimits(limits)) {
      settings.limits = limits;
      message.textContent = "";
    } else
      message.textContent =
        `しきい値は${seatedCrowdingLimit}%以上の数を小さい順に入力してください。直前の値を表示中です。`;
    settings.opacity = find<HTMLInputElement>("#diagram-opacity").valueAsNumber;
    settings.width = find<HTMLInputElement>("#diagram-width").valueAsNumber;
    settings.selectedOnly =
      find<HTMLSelectElement>("#diagram-scope").value === "selected";
    settings.colors = Array.from(
      root.querySelectorAll<HTMLInputElement>("[data-haze-color]"),
      (input) => input.value,
    );
  }
  root.addEventListener("input", (event) => {
    const target = event.target as HTMLInputElement;
    if (target === lineWidth) updateLineWidth();
    else if (
      target.type === "range" ||
      target.type === "color" ||
      target.dataset.hazeLimit !== undefined
    )
      updateSettings();
  });
  showRoute();
  return () => {
    observer.disconnect();
    cancelAnimationFrame(frame);
  };
}
