import { clock } from "./analysis";
import {
  buildRoutingIndex,
  searchJourneys,
  validateJourney,
  type RoutingIndex,
} from "./routing";
import {
  stationKey,
  type StationRef,
  type RouteQuery,
  type RouteSearchResult,
  type Journey,
  type TransferLink,
} from "./routing-model";
import { analyzeService } from "./service";
import { compareODService } from "./od-service";
import {
  escapeHtml as e,
  numberText as n,
  parseClock,
  type UIContext,
} from "./ui-utils";
import { purposeLabels } from "./temporal-model";
import { cachedRoutingIndex } from "./routing-cache";

let active = "",
  origin: StationRef,
  destination: StationRef,
  time = "07:00",
  mode: RouteQuery["mode"] = "depart",
  sort: RouteQuery["sort"] = "arrival",
  maximum = 2,
  minimum = 2,
  directOnly = false,
  useAll = false,
  error = "";
let result: RouteSearchResult | null = null,
  service: ReturnType<typeof analyzeService> | null = null,
  index: RoutingIndex | null = null;
const selectedDias = new Map<string, string>(),
  excluded = new Map<string, Set<string>>();
let linkFrom = "",
  linkTo = "",
  linkMinutes = 5,
  linkDirection: TransferLink["direction"] = "both",
  linkBasis = "";
let cachedProjects: unknown[] = [],
  cachedKey = "";
const btn = (action: string, label: string, cls = "") =>
  `<button type="button" data-route-action="${action}" class="${cls}">${label}</button>`;
function ensure(ctx: UIContext) {
  if (active !== ctx.project.datasetId) {
    active = ctx.project.datasetId!;
    origin = { datasetId: active, stationId: ctx.project.stations[0].id };
    destination = {
      datasetId: active,
      stationId: ctx.project.stations.at(-1)!.id,
    };
    result = null;
    service = null;
    error = "";
  }
  selectedDias.set(active, ctx.diaId);
}
function selections(ctx: UIContext) {
  return (useAll ? ctx.projects : [ctx.project]).map((project) => ({
    datasetId: project.datasetId!,
    project,
    timetableId:
      selectedDias.get(project.datasetId!) ?? project.timetables[0].id,
    allowedTypeIds: project.types
      .filter((t) => !excluded.get(project.datasetId!)?.has(t.id))
      .map((t) => t.id),
  }));
}
function getIndex(ctx: UIContext) {
  const list = selections(ctx);
  const key = JSON.stringify([
    list.map((s) => [
      s.datasetId,
      s.timetableId,
      s.allowedTypeIds,
      s.project.serviceClasses,
    ]),
    ctx.links,
  ]);
  if (
    !index ||
    cachedKey !== key ||
    list.some((s, i) => cachedProjects[i] !== s.project) ||
    cachedProjects.length !== list.length
  ) {
    const ids = new Set(list.map((s) => s.datasetId));
    index = cachedRoutingIndex(
      list,
      ctx.links.filter(
        (l) => ids.has(l.from.datasetId) && ids.has(l.to.datasetId),
      ),
    );
    cachedProjects = list.map((s) => s.project);
    cachedKey = key;
  }
  return index;
}
function stationRows(ctx: UIContext) {
  return (useAll ? ctx.projects : [ctx.project]).flatMap((p) =>
    p.stations.map((s) => ({
      ref: { datasetId: p.datasetId!, stationId: s.id },
      name: s.name,
      label: `${s.name} ｜ ${p.name} ｜ D${ctx.projects.indexOf(p) + 1} / ${s.id}`,
    })),
  );
}
function label(ctx: UIContext, ref: StationRef) {
  return (
    stationRows(ctx).find((s) => stationKey(s.ref) === stationKey(ref))
      ?.label ?? ""
  );
}
function stationName(ctx: UIContext, ref: StationRef) {
  return (
    ctx.projects
      .find((p) => p.datasetId === ref.datasetId)
      ?.stations.find((s) => s.id === ref.stationId)?.name ?? ref.stationId
  );
}
function query(): RouteQuery {
  return {
    origin,
    destination,
    time: parseClock(time),
    mode,
    sort,
    maxTransfers: maximum,
    minimumTransferSeconds: minimum * 60,
    directOnly,
    limit: 6,
  };
}
function run(ctx: UIContext) {
  ensure(ctx);
  try {
    const idx = getIndex(ctx),
      q = query();
    const found = searchJourneys(idx, q);
    for (const j of found.journeys) {
      const errors = validateJourney(idx, q, j);
      if (errors.length) throw new Error(errors.join(" / "));
    }
    result = found;
    const start = Math.floor(q.time / 3600) * 3600;
    service = analyzeService(
      idx,
      { ...q, sort: "arrival" },
      start,
      start + 3600,
    );
    error = "";
  } catch (err) {
    result = null;
    service = null;
    error = (err as Error).message;
  }
}
function rideTimeline(ctx: UIContext, j: Journey) {
  return `<ol class="journey-timeline">${j.legs
    .map((leg, i) => {
      const change = j.transfers[i - 1];
      return `${change ? `<li class="transfer-event"><b>乗換 ${n((change.departure - change.arrival) / 60)}分</b><span>徒歩 ${n(change.walkingSeconds / 60)}分 ＋ 待ち ${n(change.waitingSeconds / 60)}分（最低 ${n(change.minimumSeconds / 60)}分）</span></li>` : ""}<li class="ride-event" style="--route-color:${["#087f71", "#d18b2c", "#6269ad", "#ba596c", "#3979a1"][i]}"><div class="timeline-station"><time>${clock(leg.departure)}</time><b>${e(stationName(ctx, leg.origin))}</b></div><div class="ride-line"><span class="train-badge">${e(leg.typeName)} ${e(leg.trainNumber || "番号なし")}</span><small>${e(ctx.projects.find((p) => p.datasetId === leg.datasetId)?.name)} / ${e(ctx.projects.find((p) => p.datasetId === leg.datasetId)?.timetables.find((d) => d.id === leg.timetableId)?.name)}</small><details><summary>途中 ${Math.max(0, leg.stops.length - 2)}駅・停留所</summary><ul>${leg.stops
        .slice(1, -1)
        .map(
          (s) =>
            `<li>${e(stationName(ctx, { datasetId: leg.datasetId, stationId: s.stationId }))}　${s.status === "pass" ? "通過・乗降不可" : `着 ${s.arrival === undefined ? "未記載" : clock(s.arrival)} / 発 ${s.departure === undefined ? "未記載" : clock(s.departure)}`}</li>`,
        )
        .join(
          "",
        )}</ul></details></div><div class="timeline-station"><time>${clock(leg.arrival)}</time><b>${e(stationName(ctx, leg.destination))}</b></div></li>`;
    })
    .join("")}</ol>`;
}
function cards(ctx: UIContext) {
  if (!result)
    return '<div class="route-empty">駅と時刻を指定して検索してください。日跨ぎは24:10のように指定できます。</div>';
  const warningSummary = `<details class="notice"><summary>検索対象の警告・制限 ${result.warnings.length}件</summary><ul>${result.warnings.map((w) => `<li>${e(w)}</li>`).join("")}</ul></details>`;
  if (!result.journeys.length)
    return `${warningSummary}<div class="notice">${e(result.reason)}</div>`;
  return `${warningSummary}<p class="muted">${result.candidateCount}件の非劣位候補から${result.journeys.length}件を表示。${result.displayLimited ? "表示件数を制限しています。" : ""}到着指定の「時刻優先」は遅く出発できる順です。</p>${result.journeys
    .map(
      (j, i) =>
        `<details class="journey-card" ${i === 0 ? "open" : ""}><summary><span class="route-number">${i + 1}</span><span class="journey-title"><strong>${clock(j.departure)} <span>→</span> ${clock(j.arrival)}</strong><small>${e(j.legs.map((l) => l.typeName).join(" → "))}</small></span><span class="journey-summary"><b>${n(j.elapsedSeconds / 60)}分</b><small>乗換 ${j.transferCount}回 / 乗車 ${n(j.ridingSeconds / 60)}分</small></span><span class="tag green">条件適合</span></summary><div class="journey-body"><p class="muted">乗換待ち ${n(j.transferWaitSeconds / 60)}分 / 徒歩 ${n(j.walkingSeconds / 60)}分。出発前の待ちは総所要時間に含みません。</p>${rideTimeline(ctx, j)}<details><summary>路線外発着情報</summary><p class="muted">検索は路線内のみ。${
          j.legs
            .map((l) => {
              const p = ctx.projects.find((p) => p.datasetId === l.datasetId)!,
                t = p.timetables
                  .find((d) => d.id === l.timetableId)!
                  .trains.find((t) => t.id === l.trainId)!;
              return [t.externalOrigin, t.externalDestination]
                .filter(Boolean)
                .map((x) =>
                  e(
                    p.oud2?.externalTerminals.find(
                      (t) => t.id === x!.terminalId,
                    )?.name ?? "未設定",
                  ),
                )
                .join(" / ");
            })
            .filter(Boolean)
            .join(" / ") || "路線外発着の指定なし"
        }</p></details></div></details>`,
    )
    .join("")}`;
}
function servicePanel(ctx: UIContext) {
  if (!service) return "";
  const q = query(),
    start = Math.floor(q.time / 3600) * 3600;
  const h = service.journeyHeadways,
    dh = service.directHeadways;
  const demandProject = ctx.projects.find(
    (p) => p.datasetId === origin.datasetId,
  )!;
  const od = compareODService(
    demandProject,
    origin,
    destination,
    start,
    start + 3600,
    service.allJourneys,
  );
  return `<section class="panel" id="route-service"><h2>このODの需要と運行サービス</h2><p class="muted">集計窓 ${clock(start)}–${clock(start + 3600)}。窓の外の後続列車も最速到着判定に使用。直通本数と乗換を含む出発機会数を区別します。</p><div class="metrics"><article class="metric"><span>直通本数 / 有効直通</span><strong>${service.directCount} / ${service.directEffectiveCount}</strong><p>同時刻の等価な別列車は別本数</p></article><article class="metric"><span>乗換を含む有効出発機会</span><strong>${service.journeyCount}<small>機会</small></strong><p>最初の発車時刻ごとに重複排除</p></article><article class="metric"><span>期待待ち時間（乗換込み）</span><strong>${n(service.journeyWait.minutes)}<small>分</small></strong><p>利用可能時間割合 ${n(service.journeyWait.coverage * 100)}%</p></article></div><div class="table-wrap"><table><thead><tr><th>指標</th><th>平均</th><th>最大</th><th>中央値</th><th>標準偏差</th></tr></thead><tbody><tr><td>有効直通の間隔（分）</td><td>${n(dh?.mean)}</td><td>${n(dh?.max)}</td><td>${n(dh?.median)}</td><td>${n(dh?.sd)}</td></tr><tr><td>有効出発機会の間隔（分）</td><td>${n(h?.mean)}</td><td>${n(h?.max)}</td><td>${n(h?.median)}</td><td>${n(h?.sd)}</td></tr></tbody></table></div><details><summary>有効発車時刻一覧</summary><p>直通：${service.directDepartures.map(clock).join(" / ") || "なし"}</p><p>乗換込み：${service.journeyDepartures.map(clock).join(" / ") || "なし"}</p></details>${od ? `<div class="metrics"><article class="metric"><span>固定日間OD（全目的・往復）</span><strong>${n(od.daily)}<small>人</small></strong></article><article class="metric"><span>集計窓のOD</span><strong>${n(od.hourly)}<small>人</small></strong><p>推計 ${n(od.sources.estimated)} / 実測 ${n(od.sources.observed)} / 手動 ${n(od.sources.manual)}</p></article><article class="metric"><span>便がない時間に到着する推定人数</span><strong>${n(od.unserved)}<small>人</small></strong><p>容量超過・積み残しとは異なる指標</p></article></div><p class="muted">需要加重の期待待ち ${n(od.expectedWaitMinutes)}分。${e(od.assumption)}。日間ODはダイヤ切替で再生成しません。</p>` : '<p class="notice">このODの時間帯需要は未生成、またはデータセット間ODです。「時間帯別OD」で日間需要を生成・設定してください。</p>'}<p class="muted">直通期待待ち ${n(service.directWait.minutes)}分。最速到着（窓開始以降）：${service.fastest ? `${clock(service.fastest.departure)} → ${clock(service.fastest.arrival)}` : "なし"}。運賃・営業キロ・容量・混雑率は算出していません。</p></section>`;
}
export function renderRouting(ctx: UIContext) {
  ensure(ctx);
  const rows = stationRows(ctx);
  const linkOptions = ctx.projects.flatMap((p) =>
    p.stations.map((s) => ({
      key: stationKey({ datasetId: p.datasetId!, stationId: s.id }),
      label: `${s.name} ｜ ${p.name} ｜ D${ctx.projects.indexOf(p) + 1} / ${s.id}`,
    })),
  );
  return `<div id="route-page"><section class="panel route-search"><div class="panel-heading"><span class="eyebrow">TIMETABLE JOURNEY PLANNER</span><h2>経路を検索する</h2><p>鉄道・バス共通。原データの着発時刻と、設定した乗換条件から検索します。</p></div><label>利用データセット<select id="route-dataset">${ctx.projects.map((p) => `<option value="${e(p.datasetId)}" ${p.datasetId === active ? "selected" : ""}>${e(p.name)}</option>`).join("")}</select></label><div class="journey-form"><label>出発駅・停留所<input id="route-origin" list="route-origin-list" value="${e(label(ctx, origin))}" autocomplete="off"><datalist id="route-origin-list">${rows.map((r) => `<option value="${e(r.label)}"></option>`).join("")}</datalist></label>${btn("swap", "⇄ 入替", "swap-button")}<label>到着駅・停留所<input id="route-destination" list="route-destination-list" value="${e(label(ctx, destination))}" autocomplete="off"><datalist id="route-destination-list">${rows.map((r) => `<option value="${e(r.label)}"></option>`).join("")}</datalist></label><label>時刻（24時以降も可）<input id="route-time" value="${e(time)}" inputmode="numeric"></label><label>指定方法<select id="route-mode"><option value="depart" ${mode === "depart" ? "selected" : ""}>出発時刻指定</option><option value="arrive" ${mode === "arrive" ? "selected" : ""}>到着時刻指定</option></select></label>${btn("search", "経路を検索", "primary")}</div><div class="route-options"><label>最大乗換回数<input id="route-maximum" type="number" min="0" max="4" step="1" value="${maximum}"></label><label>最低乗換時間（分）<input id="route-minimum" type="number" min="0" step="any" value="${minimum}"></label><label>経路条件<select id="route-direct"><option value="allow" ${!directOnly ? "selected" : ""}>乗換を許可</option><option value="direct" ${directOnly ? "selected" : ""}>直通のみ</option></select></label><label>並び替え<select id="route-sort"><option value="arrival" ${sort === "arrival" ? "selected" : ""}>時刻優先（早着 / 到着指定は遅発）</option><option value="transfers" ${sort === "transfers" ? "selected" : ""}>乗換が少ない</option><option value="riding" ${sort === "riding" ? "selected" : ""}>乗車時間が短い</option></select></label><label>検索範囲<select id="route-all"><option value="single" ${!useAll ? "selected" : ""}>選択データセットのみ</option><option value="all" ${useAll ? "selected" : ""}>読み込み済みを併用（徒歩設定が必要）</option></select></label></div><details><summary>使用ダイヤ・対象種別を確認</summary><p class="notice">「営業区分・定員」で営業と明示した列車だけを使用します。非営業・要確認は、この種別フィルターで選んでも検索されません。</p>${selections(
    ctx,
  )
    .map(
      (s) =>
        `<div class="dataset-options"><b>${e(s.project.name)}</b><label>ダイヤ<select data-route-dia="${e(s.datasetId)}">${s.project.timetables.map((d) => `<option value="${e(d.id)}" ${d.id === s.timetableId ? "selected" : ""}>${e(d.name)}</option>`).join("")}</select></label><div class="type-options">${s.project.types.map((t) => `<label><input type="checkbox" data-route-type="${e(t.id)}" data-route-dataset="${e(s.datasetId)}" ${s.allowedTypeIds!.includes(t.id) ? "checked" : ""}>${e(t.name)}</label>`).join("")}</div></div>`,
    )
    .join(
      "",
    )}</details></section>${error ? `<div role="alert" class="notice">${e(error)}</div>` : ""}<div class="route-result-heading"><h2>検索結果</h2><div class="actions">${btn("previous", "← 前の便")}${btn("next", "次の便 →")}</div></div>${cards(ctx)}${servicePanel(ctx)}<details class="panel"><summary>徒歩連絡の手動設定（列車間の乗換）</summary><p class="muted">同名駅でも自動連絡しません。実際に接続できる場合だけ、設定根拠を入力してください。データセット間検索では「読み込み済みを併用」を選択します。</p><div class="route-options"><label>接続元<select id="link-from"><option value="">選択してください</option>${linkOptions.map((x) => `<option value="${e(x.key)}" ${linkFrom === x.key ? "selected" : ""}>${e(x.label)}</option>`).join("")}</select></label><label>接続先<select id="link-to"><option value="">選択してください</option>${linkOptions.map((x) => `<option value="${e(x.key)}" ${linkTo === x.key ? "selected" : ""}>${e(x.label)}</option>`).join("")}</select></label><label>徒歩（分）<input id="link-minutes" type="number" min="0" step="any" value="${linkMinutes}"></label><label>方向<select id="link-direction"><option value="both" ${linkDirection === "both" ? "selected" : ""}>双方向</option><option value="forward" ${linkDirection === "forward" ? "selected" : ""}>接続元 → 接続先のみ</option></select></label><label>設定根拠<input id="link-basis" value="${e(linkBasis)}" placeholder="実測・手動仮定など"></label>${btn("add-link", "徒歩連絡を追加")}</div>${ctx.links.map((l) => `<p>${e(stationName(ctx, l.from))} → ${e(stationName(ctx, l.to))} / ${n(l.walkingSeconds / 60)}分 / ${l.direction === "both" ? "双方向" : "片方向"} / ${e(l.basis)} ${btn("delete-link:" + l.id, "削除")}</p>`).join("")}</details><p class="muted">原ファイルの読み込み警告は画面上部に保持しています。別レコード間の直通継続・外部区間検索・運賃・混雑率は未対応です。</p></div>`;
}
export function routeClick(button: HTMLElement, ctx: UIContext) {
  const action = button.dataset.routeAction;
  if (!action) return false;
  error = "";
  try {
    if (action === "swap") {
      [origin, destination] = [destination, origin];
      run(ctx);
    } else if (action === "search") run(ctx);
    else if (action === "previous" || action === "next") {
      const first = result?.journeys[0];
      if (first) {
        mode = action === "next" ? "depart" : "arrive";
        time = clock(
          action === "next"
            ? first.departure + 1
            : Math.max(0, first.arrival - 1),
        );
        run(ctx);
      } else {
        time = clock(
          Math.max(0, parseClock(time) + (action === "next" ? 3600 : -3600)),
        );
        run(ctx);
      }
    } else if (action === "add-link") {
      if (
        !linkFrom ||
        !linkTo ||
        !linkBasis.trim() ||
        !Number.isFinite(linkMinutes) ||
        linkMinutes < 0
      )
        throw new Error("接続元・接続先・徒歩時間・設定根拠を入力してください");
      const [fd, fs] = JSON.parse(linkFrom),
        [td, ts] = JSON.parse(linkTo);
      const link: TransferLink = {
        id: crypto.randomUUID(),
        from: { datasetId: fd, stationId: fs },
        to: { datasetId: td, stationId: ts },
        walkingSeconds: linkMinutes * 60,
        direction: linkDirection,
        basis: linkBasis,
      };
      if (stationKey(link.from) === stationKey(link.to))
        throw new Error("異なる駅・停留所を選択してください");
      ctx.links.push(link);
      ctx.save();
      run(ctx);
    } else if (action.startsWith("delete-link:")) {
      const i = ctx.links.findIndex((l) => l.id === action.slice(12));
      if (i >= 0) ctx.links.splice(i, 1);
      ctx.save();
      run(ctx);
    }
  } catch (err) {
    error = (err as Error).message;
  }
  ctx.render();
  return true;
}
export function routeChange(el: HTMLInputElement, ctx: UIContext) {
  try {
    if (el.id === "route-dataset") {
      ctx.activate(el.value);
      return;
    }
    if (el.id === "route-origin" || el.id === "route-destination") {
      const rows = stationRows(ctx);
      const matches = rows.filter(
        (r) => r.label === el.value || r.name === el.value,
      );
      const partial = matches.length
        ? matches
        : rows.filter((r) => r.name.includes(el.value));
      if (partial.length !== 1)
        throw new Error("候補から駅名・データセット・IDを選択してください");
      if (el.id === "route-origin") origin = partial[0].ref;
      else destination = partial[0].ref;
    } else if (el.id === "route-time") time = el.value;
    else if (el.id === "route-mode") mode = el.value as typeof mode;
    else if (el.id === "route-sort") sort = el.value as typeof sort;
    else if (el.id === "route-maximum") maximum = Number(el.value);
    else if (el.id === "route-minimum") minimum = Number(el.value);
    else if (el.id === "route-direct") directOnly = el.value === "direct";
    else if (el.id === "route-all") {
      useAll = el.value === "all";
      if (!useAll) {
        origin = { datasetId: active, stationId: ctx.project.stations[0].id };
        destination = {
          datasetId: active,
          stationId: ctx.project.stations.at(-1)!.id,
        };
      }
    } else if (el.dataset.routeDia) {
      selectedDias.set(el.dataset.routeDia, el.value);
      if (el.dataset.routeDia === active) {
        const select = document.querySelector<HTMLSelectElement>("#diaId")!;
        select.value = el.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        return;
      }
    } else if (el.dataset.routeType) {
      const id = el.dataset.routeDataset!,
        set = excluded.get(id) ?? new Set();
      if (el.checked) set.delete(el.dataset.routeType);
      else set.add(el.dataset.routeType);
      excluded.set(id, set);
    } else if (el.id.startsWith("link-")) {
      if (el.id === "link-from") linkFrom = el.value;
      if (el.id === "link-to") linkTo = el.value;
      if (el.id === "link-minutes") linkMinutes = Number(el.value);
      if (el.id === "link-direction")
        linkDirection = el.value as typeof linkDirection;
      if (el.id === "link-basis") linkBasis = el.value;
      return;
    }
    run(ctx);
  } catch (err) {
    error = (err as Error).message;
    result = null;
    service = null;
  }
  ctx.render();
}
export function routeInput(el: HTMLInputElement, ctx: UIContext) {
  if (!["route-origin", "route-destination"].includes(el.id)) return;
  const list = document.querySelector(`#${el.id}-list`);
  const rows = stationRows(ctx).filter(
    (r) => r.name.includes(el.value) || r.label === el.value,
  );
  if (list)
    list.innerHTML = rows
      .map((r) => `<option value="${e(r.label)}"></option>`)
      .join("");
}
export function refreshRoute(ctx: UIContext) {
  ensure(ctx);
  if (result) run(ctx);
}
