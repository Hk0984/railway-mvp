import { drawHourlyDemand } from "./hourly-demand-preview";
import { clock, trainVisits } from "./analysis";
import { capacityForTrain, type FormationValues } from "./capacity-model";
import { completeTransportCapacity, formationPosition, formationProfile, formationStages, hasFormationChanges, formationUnitGroups } from "./train-formation";
import {
  classLabels,
  serviceClass,
  trainClassKey,
  type ServiceClass,
} from "./classification";
import {
  activeDemandDay,
  arrivalDirections,
  arrivalHourCount,
  arrivalHours,
  boundaryTrains,
  defaultLineTransferSeconds,
  demandDayLabels,
  hasSeparateDemand,
  initialArrivalShares,
  lineDemandForDay,
  periods,
  type LineDemand,
  type OutsideArea,
} from "./line-demand";
import type { Project, Timetable, Train } from "./model";
import { isOperationPattern, operationGroup } from "./operation-numbers";
import {
  defaultPurposeShares,
  stationAttributes,
  tripPurposeLabels,
  tripPurposes,
  type PurposeShares,
  type StationAttribute,
  type StationDemandProfile,
} from "./station-demand-profile";
import { escapeHtml as e, numberText as n } from "./ui-utils";

export function options(items: { id: string; name: string }[], value: string) {
  return items
    .map(
      ({ id, name }) =>
        `<option value="${e(id)}" ${id === value ? "selected" : ""}>${e(name)}</option>`,
    )
    .join("");
}

const demandDays = Object.entries(demandDayLabels).map(([id, name]) => ({
  id,
  name,
}));

export function demandDayField(project: Project) {
  return `<label>需要の日区分<select id="active-demand-day">${options(demandDays, activeDemandDay(project))}</select></label>`;
}

export function demandDayStatus(project: Project) {
  const day = activeDemandDay(project);
  if (day === "weekday") return "";
  return hasSeparateDemand(project)
    ? `${demandDayLabels[day]}の専用設定を使用します。`
    : `平日（月〜木）の需要を使用しています。${demandDayLabels[day]}の設定を保存すると、専用設定に切り替わります。`;
}

export function timetableField(project: Project, diaId: string) {
  return `<label>対象ダイヤ<select id="active-dia">${options(project.timetables, diaId)}</select></label>`;
}

export function missingSettings(p: Project, dia: Timetable) {
  const d = lineDemandForDay(p);
  const missing: string[] = [];
  if (p.stations.some(({ id }) => !Object.hasOwn(d.counts, id)))
    missing.push("駅利用者数");
  if (
    p.stations.some(({ id }) => {
      const profile = d.stationProfiles?.[id];
      return !profile?.primary && !profile?.secondary && !profile?.shares;
    })
  )
    missing.push("駅属性と利用目的");
  const hasDemand = p.lineDemand !== undefined || hasSeparateDemand(p);
  if (!hasDemand) missing.push("時間帯の振り分け");
  const configuredBoundaries = new Set(d.outside.map((area) => area.stationId));
  if (
    d.outside.some(
      (area) =>
        area.mode === "through" &&
        (["inbound", "outbound"] as const).some(
          (flow) => area[flow] > 0 && !area.trains[dia.id]?.[flow].length,
        ),
    ) ||
    dia.trains.some(
      (train) =>
        !train.cancelled &&
        [train.externalOrigin, train.externalDestination].some(
          (end) => end && !configuredBoundaries.has(end.boundaryStationId),
        ),
    )
  )
    missing.push("（路線外方面）");
  if (
    dia.trains.some((train) => {
      if (train.cancelled) return false;
      const { state } = serviceClass(p, dia.id, train);
      return (
        state === "review" ||
        (state === "passenger" &&
          !completeTransportCapacity(p, dia.id, train))
      );
    })
  )
    missing.push("営業区分と輸送定員");
  return missing;
}

const num = (
  name: string,
  value: number | undefined,
  label: string,
  step = "any",
  min = 0,
) =>
  `<input name="${name}" aria-label="${e(label)}" type="number" min="${min}" max="1000000000" step="${step}" value="${value ?? ""}">`;

function operationGroups(p: Project) {
  const groups = new Map<string, { examples: Set<string>; count: number; inherited: number }>();
  const ungrouped: { timetable: string; train: Train }[] = [];
  const get = (id: string) => {
    if (!groups.has(id)) groups.set(id, { examples: new Set(), count: 0, inherited: 0 });
    return groups.get(id)!;
  };
  for (const { name, trains } of p.timetables)
    for (const train of trains) {
      if (train.cancelled) continue;
      for (const [id, number] of formationUnitGroups(p, train)) {
        const row = get(id);
        if (row.examples.size < 3) row.examples.add(number);
      }
      const { group, numbers, inheritedFrom } = operationGroup(p, train);
      if (!group) {
        ungrouped.push({ timetable: name, train });
        continue;
      }
      const row = get(group);
      row.count++;
      if (inheritedFrom) row.inherited++;
      if (row.examples.size < 3) row.examples.add(numbers[0]);
    }
  for (const map of [p.capacitySettings?.operationGroups, p.capacitySettings?.operationGroupCars])
    for (const id of Object.keys(map ?? {})) if (isOperationPattern(id)) get(id);
  return { groups: [...groups].sort(([a], [b]) => a.localeCompare(b)), ungrouped };
}

function ungroupedOperationTrains(
  p: Project,
  trains: readonly { timetable: string; train: Train }[],
) {
  if (!trains.length) return "";
  const stations = new Map(p.stations.map(({ id, name }) => [id, name]));
  const terminals = new Map(
    p.oud2?.externalTerminals.map(({ id, name }) => [id, name]),
  );
  const types = new Map(p.types.map(({ id, name }) => [id, name]));
  const rows = trains.map(({ timetable, train }) => {
    const visits = trainVisits(train);
    const first = visits[0];
    const last = visits.at(-1);
    const { externalOrigin, externalDestination } = train;
    const from = externalOrigin
      ? terminals.get(externalOrigin.terminalId)
      : stations.get(first?.stationId ?? "");
    const to = externalDestination
      ? terminals.get(externalDestination.terminalId)
      : stations.get(last?.stationId ?? "");
    const departure = externalOrigin ? externalOrigin.externalTime : first?.departure;
    const arrival = externalDestination ? externalDestination.externalTime : last?.arrival;
    const direction = train.direction === "down" ? "下り" : "上り";
    return `<tr>
      <td>${e(timetable)}</td>
      <th scope="row">${e(train.number || train.id)}<small>${e(types.get(train.typeId) ?? train.typeId)}・${direction}</small></th>
      <td>${e(from ?? "不明")} ${departure === undefined ? "発時刻未記載" : clock(departure)}</td>
      <td>${e(to ?? "不明")} ${arrival === undefined ? "着時刻未記載" : clock(arrival)}</td>
    </tr>`;
  });
  return `<details open data-ungrouped-operation-trains><summary>運用番号でグループ化できない列車（${n(trains.length, 0)}本）</summary>
    <div class="table-scroll train-config" role="region" tabindex="0" aria-label="運用番号でグループ化できない列車の一覧"><table><thead><tr><th scope="col">ダイヤ</th><th scope="col">列車</th><th scope="col">始発駅・発時刻</th><th scope="col">終着駅・着時刻</th></tr></thead><tbody>${rows.join("")}</tbody></table></div></details>`;
}

function formationFields(p: Project) {
  const caps = p.capacitySettings;
  const modes = [
    { id: "type", name: "種別から編成定員と両数を設定" },
    { id: "operation", name: "運用番号から編成定員と両数を設定" },
  ];
  const hasLegacy = Object.keys(caps?.operationGroups ?? {}).some((id) => /^[A-Z]+$/.test(id));
  if (hasLegacy) modes.push({ id: "legacy", name: "保存済みの旧運用記号設定を使用" });
  const mode = caps?.formationSource ?? (hasLegacy ? "legacy" : "type");
  const { groups, ungrouped } = operationGroups(p);
  const groupedCount = groups.reduce((total, [, { count }]) => total + count, 0);
  const inheritedCount = groups.reduce((total, [, { inherited }]) => total + inherited, 0);
  const trainCount = groupedCount + ungrouped.length;
  return `<div class="fields single-field"><label>編成の設定方法<select name="formation-source">${options(modes, mode)}</select></label></div>
    <fieldset class="operation-formation-fields" data-operation-formations ${mode === "operation" ? "" : "hidden disabled"}>
      <p class="muted">運用番号の数字部分を <code>**</code> に置き換えます。例 <code>32SH → **SH</code>、<code>39C● → **C●</code>、<code>A01 → A**</code>。番線と時刻から前列車接続が一意に決まる場合は、前列車の運用番号を引き継ぎます。設定は全ダイヤ共通です。グループの入力欄が空欄の場合は種別の設定を使います。</p>
      ${groups.length ? `<p class="muted">全ダイヤの${n(trainCount, 0)}本のうち、${n(groupedCount, 0)}本をグループ化しました${inheritedCount ? `（うち${n(inheritedCount, 0)}本は前列車から継承）` : ""}。</p><div class="table-scroll"><table><thead><tr><th scope="col">運用番号グループ</th><th scope="col">運用番号の例</th><th scope="col">列車数（全ダイヤ）</th><th scope="col">輸送定員（人／編成）</th><th scope="col">編成両数</th></tr></thead><tbody>${groups.map(([group, { examples, count }], i) => {
        const spec = caps?.operationGroups?.[group];
        const cars = caps?.operationGroupCars?.[group] ?? spec?.carCount;
        return `<tr><th scope="row"><code>${e(group)}</code></th><td>${e([...examples].join("、") || "—")}</td><td>${n(count, 0)}</td><td>${num("group-cap" + i, spec?.kind === "transport" ? spec.value : undefined, group + "の輸送定員", "1", 1)}</td><td>${num("group-cars" + i, cars, group + "の編成両数", "1", 1)}</td></tr>`;
      }).join("")}</tbody></table></div>` : '<p class="muted">グループ化できる運用番号が見つかりませんでした。列車種別または列車別の設定を使用できます。</p>'}
      <div class="fields single-field"><label>未分類列車の仮輸送定員（人／編成、任意）${num("ungrouped-operation-capacity", caps?.ungroupedOperationCapacity, "未分類列車の仮輸送定員（人／編成）", "1", 1)}</label></div>
      <p class="muted">全ダイヤの未分類列車に共通です。列車別の定員を優先します。空欄の場合は、種別やダイヤ共通の定員を使います。</p>
      ${ungroupedOperationTrains(p, ungrouped)}
    </fieldset>`;
}

function formationSectionFields(p: Project, dia: Timetable) {
  const names = new Map(p.stations.map(station => [station.id, station.name]));
  const rows = dia.trains.flatMap((train, ti) => {
    if (train.cancelled || !hasFormationChanges(train)) return [];
    const visits = trainVisits(train);
    const stages = formationStages(train, visits);
    const profile = formationProfile(p, dia.id, train, visits);
    const saved = p.capacitySettings?.formationSections?.[trainClassKey(dia.id, train.id)];
    return stages.map(({index,stop,changes}, si) => {
      const last = stages[si + 1]?.stop ?? visits.at(-1)!;
      const name = train.number || train.id;
      const route = `${names.get(stop.stationId) ?? stop.stationId} → ${names.get(last.stationId) ?? last.stationId}`;
      const label = name + " " + route;
      const values = saved?.[formationPosition(stop)];
      const effective = profile?.[index];
      const summary = changes.length ? changes.map(work => work.code === 1 ? "増結" : "解結").join("・") + "後" : "始発から";
      return `<tr><th scope="row">${e(name)}</th><td>${e(route)}<small>${stop.departure === undefined ? "" : clock(stop.departure) + "発 ／ "}${summary}</small></td>
        <td>${num("formation-cap-" + ti + "-" + si, values?.capacity, label + "の輸送定員", "1", 1)}${values?.capacity === undefined && effective?.capacity !== undefined ? `<small>適用 ${n(effective.capacity, 0)}人</small>` : ""}</td>
        <td>${num("formation-cars-" + ti + "-" + si, values?.carCount, label + "の編成両数", "1", 1)}${values?.carCount === undefined && effective?.carCount !== undefined ? `<small>適用 ${n(effective.carCount, 0)}両</small>` : ""}</td></tr>`;
    });
  });
  return rows.length ? `<details id="formation-sections"><summary>増結・解結の区間別編成（${n(rows.length, 0)}区間）</summary>
    <p class="muted">増結・解結を行った駅から先の編成を指定できます。個別の区間設定を優先します。運用番号で編成を特定できるときは、構成する編成の登録値を合算します。</p>
    <div class="table-scroll train-config"><table><thead><tr><th scope="col">列車</th><th scope="col">適用区間</th><th scope="col">輸送定員（人／編成）</th><th scope="col">編成両数</th></tr></thead><tbody>${rows.join("")}</tbody></table></div></details>` : "";
}

export function updateFormationSource(form: HTMLFormElement, mode: string) {
  const panel = form.querySelector<HTMLFieldSetElement>("[data-operation-formations]")!;
  panel.hidden = panel.disabled = mode !== "operation";
}

export function updateTrainCapacityHints(form: HTMLFormElement, p: Project, dia: Timetable) {
  form.querySelectorAll<HTMLElement>("[data-capacity-hint]").forEach((hint, i) => {
    const { spec, source } = capacityForTrain(p, dia.id, dia.trains[i]);
    hint.textContent = source !== "train" && spec?.kind === "transport"
      ? `継承値 ${n(spec.value, 0)} 人`
      : "";
  });
}

function shareFields(shares: number[], prefix: string) {
  return `<div class="period-fields">${periods
    .map(
      (period, i) =>
        `<label><span>${period.label}</span><small>${period.note}</small><span class="field-unit">${num(prefix + i, shares[i], period.label + "の割合")}<span>%</span></span></label>`,
    )
    .join("")}</div>`;
}

function stationProfileRow(
  name: string,
  i: number,
  profile?: StationDemandProfile,
) {
  const primary = profile?.primary,
    secondary = profile?.secondary;
  const attributes = (
    role: "primary" | "secondary",
    value?: StationAttribute,
  ) =>
    `<select name="station-${role}-${i}" data-station-attribute="${role}" aria-label="${e(name + (role === "primary" ? "の主属性" : "の副属性"))}"><option value="">${role === "primary" ? "未設定" : "なし"}</option>${options(stationAttributes, value ?? "")}</select>`;
  const automatic = defaultPurposeShares(primary, secondary);
  const purposes = tripPurposes
    .map(
      (purpose) =>
        `<td><input type="number" min="0" max="100" step="any" name="station-${purpose}-${i}" data-station-purpose="${purpose}" aria-label="${e(name + "の" + tripPurposeLabels[purpose] + "の割合（%）")}" value="${profile?.shares?.[purpose] ?? ""}" placeholder="${automatic[purpose]}"></td>`,
    )
    .join("");
  return `<tr data-station-profile><th scope="row">${e(name)}</th><td>${attributes("primary", primary)}</td><td>${attributes("secondary", secondary)}</td>${purposes}</tr>`;
}

export function updateStationPurposeDefaults(row: HTMLElement) {
  const attribute = (role: "primary" | "secondary") =>
    (row.querySelector<HTMLSelectElement>(`[data-station-attribute="${role}"]`)!
      .value || undefined) as StationAttribute | undefined;
  const shares = defaultPurposeShares(
    attribute("primary"),
    attribute("secondary"),
  );
  for (const purpose of tripPurposes)
    row.querySelector<HTMLInputElement>(
      `[data-station-purpose="${purpose}"]`,
    )!.placeholder = String(shares[purpose]);
}

function destinationArrivalFields(project: Project, demand: LineDemand) {
  const baseline = initialArrivalShares(demand.shares.local);
  const shares = demand.destinationArrival?.shares ?? {
    up: baseline,
    down: baseline,
  };
  const hours = arrivalHours(project);
  return `
    <p class="muted">1日の到着需要を上り・下りそれぞれ100%に振り分けます。乗換がある場合は目的地に着く列車の方向を使います。路線外への流出は接続駅への到着時刻で集計します。</p>
    <label class="check"><input type="checkbox" name="arrival-smooth" ${demand.destinationArrival?.smooth !== false ? "checked" : ""}> 到着需要をなだらかに補間</label>
    <p class="muted">各1時間の合計割合を保ち、時刻の境目をひと続きの増減でつなぎます。</p>
    <div class="arrival-preview">
      <p class="arrival-preview-key muted"><span>上り</span><span>下り</span><span>1時間あたりの到着割合（%）</span></p>
      <canvas data-arrival-preview="${hours[0].index}" role="img" aria-label="上り・下りの到着需要の推移" width="720" height="144"></canvas>
    </div>
    <div class="table-scroll arrival-hour-grid">
      <table><thead><tr><th scope="col">目的地への到着時刻</th><th scope="col">上り（%）</th><th scope="col">下り（%）</th></tr></thead>
      <tbody>${hours
        .map(
          ({ index, label }) =>
            `<tr><th scope="row">${label}</th>${arrivalDirections
              .map(
                (dir) =>
                  `<td><input type="number" name="arr-hour-${dir}-${index}" aria-label="${dir === "up" ? "上り" : "下り"} ${label}の到着割合" min="0" max="100" step="any" value="${shares[dir][index]}"></td>`,
              )
              .join("")}</tr>`,
        )
        .join("")}</tbody></table>
    </div>
    <p class="muted">合計　上り <output data-arrival-total="up">100%</output> ／ 下り <output data-arrival-total="down">100%</output></p>`;
}

export function updateDemandTiming(form: HTMLFormElement) {
  const mode = (
    form.elements.namedItem("demand-time-mode") as HTMLSelectElement
  ).value;
  for (const panel of Array.from(
    form.querySelectorAll<HTMLFieldSetElement>("[data-demand-timing]"),
  ))
    panel.hidden = panel.disabled = panel.dataset.demandTiming !== mode;
  if (mode === "arrival") updateArrivalPreview(form);
}
export function updateArrivalPreview(form: HTMLFormElement) {
  const shares = { up: [] as number[], down: [] as number[] };
  for (const dir of arrivalDirections) {
    const values = shares[dir];
    const fields = Array.from(
      form.querySelectorAll<HTMLInputElement>(`[name^="arr-hour-${dir}-"]`),
    );
    for (const field of fields)
      values[Number(field.name.slice(("arr-hour-" + dir + "-").length))] =
        Math.max(0, field.valueAsNumber || 0);
    const total = values.reduce((sum, value) => sum + value, 0);
    form.querySelector<HTMLOutputElement>(
      `[data-arrival-total="${dir}"]`,
    )!.value = `${n(total, 4)}%`;
  }
  const canvas = form.querySelector<HTMLCanvasElement>(
    "[data-arrival-preview]",
  )!;
  const smooth = (form.elements.namedItem("arrival-smooth") as HTMLInputElement)
    .checked;
  drawHourlyDemand(
    canvas,
    shares,
    Number(canvas.dataset.arrivalPreview),
    smooth,
  );
}

export function areaCard(
  p: Project,
  dia: Timetable,
  area: OutsideArea,
  i: number,
) {
  const trainOptions = (station: string, flow: "inbound" | "outbound") => {
    const selected = new Set(area.trains[dia.id]?.[flow]);
    return boundaryTrains(dia, station, flow)
      .map(
        (train) =>
          `<option value="${e(train.id)}" ${selected.has(train.id) ? "selected" : ""}>${e(train.number || train.id)} ／ ${train.direction === "down" ? "下り" : "上り"}${serviceClass(p, dia.id, train).state !== "passenger" ? "（営業区分を確認）" : ""}</option>`,
      )
      .join("");
  };
  return `<div class="area-card" data-area="${e(area.id)}">
    <div class="section-heading"><h3>方面 ${i + 1}</h3><button type="button" data-remove-area="${i}" class="quiet">削除</button></div>
    <div class="fields">
      <label>方面名<input name="area-name" value="${e(area.name)}" placeholder="都心方面" required maxlength="100"></label>
      <label>接続駅<select name="area-station">${options(p.stations, area.stationId)}</select></label>
      <label>1日の流入（人）${num("area-in", area.inbound, "1日の流入")}</label>
      <label>1日の流出（人）${num("area-out", area.outbound, "1日の流出")}</label>
      <label>接続方法<select name="area-mode"><option value="transfer">接続駅で乗換</option><option value="through" ${area.mode === "through" ? "selected" : ""}>列車で直通</option></select></label>
    </div>
    <label class="check"><input type="checkbox" name="area-included" ${area.included ? "checked" : ""}> 接続駅の人数に含まれる（流入は乗車数、流出は降車数）</label>
    <div class="fields through-fields" ${area.mode === "transfer" ? "hidden" : ""}>
      <label>流入に使う直通列車<select name="trains-in" multiple size="4">${trainOptions(area.stationId, "inbound")}</select></label>
      <label>流出に使う直通列車<select name="trains-out" multiple size="4">${trainOptions(area.stationId, "outbound")}</select></label>
      <p class="muted">接続駅を路線内の始発・終着とする列車を選びます。複数選択できます。</p>
    </div>
  </div>`;
}

export function settingsBody(p: Project, dia: Timetable, draft?: LineDemand) {
  const d = draft ?? lineDemandForDay(p);
  const timing = d.stationProfileTiming
    ? "profile"
    : d.destinationArrival?.enabled
      ? "arrival"
      : "boarding";
  return `
  <section class="surface timetable-settings">
    <div class="section-heading"><div><h2>ダイヤデータ</h2><p class="muted">駅順が同じ .oud2 には現在の設定を引き継ぎます。同じ駅順の設定JSONは、開いているダイヤに適用します。</p></div></div>
    <div class="fields">
      ${timetableField(p, dia.id)}
      ${demandDayField(p)}
      <label>文字コード<select id="encoding"><option value="auto">自動判定</option><option value="utf-8">UTF-8</option><option value="shift_jis">Shift_JIS</option><option value="utf-16le">UTF-16 LE</option><option value="utf-16be">UTF-16 BE</option></select></label>
      <label class="file-pick">ファイルを開く<input type="file" id="open-file" accept=".oud2,.json"></label>
    </div>
    <div class="inline-actions"><button type="button" data-action="export">設定のJSONを保存</button><button type="button" data-action="sample">サンプルを開く</button></div>
    ${p.oud2?.warnings.length ? `<details><summary>取り込み時の注意（${p.oud2.warnings.length}件）</summary><ul>${p.oud2.warnings.map((v) => `<li>${e(v)}</li>`).join("")}</ul></details>` : ""}
  </section>
  <form id="settings-form">
    <section class="surface">
      <div class="section-heading"><div><h2>駅利用者数</h2><p class="muted">1日あたりの人数。行先は到達可能な駅の降車人数に重みを掛けて配分します。</p><p class="muted" id="demand-day-status">${demandDayStatus(p)}</p></div></div>
      <div class="table-scroll"><table><thead><tr><th scope="col">駅</th><th scope="col">乗車（人）</th><th scope="col">降車（人）</th><th scope="col">行先の重み</th></tr></thead>
      <tbody>${p.stations
        .map((s, i) => {
          const c = d.counts[s.id];
          return `<tr><th scope="row">${e(s.name)}</th><td>${num("board" + i, c?.board, s.name + "の乗車人数")}</td><td>${num("alight" + i, c?.alight, s.name + "の降車人数")}</td><td>${num("weight" + i, c?.weight ?? 1, s.name + "の行先の重み")}</td></tr>`;
        })
        .join("")}</tbody></table></div>
    </section>
    <section class="surface">
      <div class="section-heading"><div><h2>駅の属性と利用目的</h2><p class="muted">属性から目的別の行き先を推計します。副属性の反映は25%です。割合をすべて空欄にすると欄に表示された初期値を使います。個別に指定する場合は3項目を合計100%にしてください。</p></div></div>
      <div class="table-scroll"><table class="station-purpose-table"><thead><tr><th scope="col">駅</th><th scope="col">主属性</th><th scope="col">副属性</th>${tripPurposes.map((purpose) => `<th scope="col">${tripPurposeLabels[purpose]}（%）</th>`).join("")}</tr></thead>
      <tbody>${p.stations.map((s, i) => stationProfileRow(s.name, i, d.stationProfiles?.[s.id])).join("")}</tbody></table></div>
    </section>
    <section class="surface">
      <div class="section-heading"><div><h2>時間帯の振り分け</h2></div></div>
      <div class="fields single-field">
        <label>時間帯の基準<select name="demand-time-mode" aria-label="時間帯の基準">
          <option value="boarding">出発駅に着く時間帯（4枠）</option>
          <option value="arrival" ${timing === "arrival" ? "selected" : ""}>目的地に着く時刻（上下別・1時間ごと）</option>
          <option value="profile" ${timing === "profile" ? "selected" : ""}>駅の属性と利用目的から到着時刻を推計</option>
        </select></label>
      </div>
      <fieldset class="demand-time-fields" data-demand-timing="boarding" ${timing !== "boarding" ? "hidden disabled" : ""}>
      <p class="muted">合計100%。時間帯内は一様に出発駅へ到着すると仮定します。</p>
      ${shareFields(d.shares.local, "local")}
      <details ${d.shares.inbound || d.shares.outbound ? "open" : ""}><summary>流入・流出だけ別の割合を使う</summary>
        ${(["inbound", "outbound"] as const)
          .map(
            (flow) => `
          <label class="check"><input type="checkbox" name="override-${flow}" ${d.shares[flow] ? "checked" : ""}> ${flow === "inbound" ? "流入" : "流出"}の割合を個別設定</label>
          <div data-override="${flow}" ${d.shares[flow] ? "" : "hidden"}>${shareFields(d.shares[flow] ?? d.shares.local, flow)}</div>`,
          )
          .join("")}
      </details>
      </fieldset>
      <fieldset class="demand-time-fields" data-demand-timing="arrival" ${timing === "arrival" ? "" : "hidden disabled"}>
        ${destinationArrivalFields(p, d)}
      </fieldset>
      <fieldset class="demand-time-fields" data-demand-timing="profile" ${timing === "profile" ? "" : "hidden disabled"}>
        <p class="muted">通勤・通学の朝と帰宅の時間帯、非定期の日中・夜間などの傾向から、到着需要を1時間ごとに推計します。路線外方面の時刻には、保存済みの4枠の割合を使います。</p>
      </fieldset>
    </section>
    <section class="surface">
      <div class="section-heading"><div><h2>路線外方面</h2><p class="muted">対象路線の外から入る人数と、外へ出る人数を設定します。</p></div><button type="button" data-action="add-area">方面を追加</button></div>
      <div id="outside-areas">${d.outside.map((area, i) => areaCard(p, dia, area, i)).join("")}</div>
    </section>
    <section class="surface">
      <div class="section-heading"><div><h2>営業区分と輸送定員</h2><p class="muted">定員は1編成あたりの人数です。列車別の定員・両数があればそちらを優先します。</p></div><button type="button" data-action="all-passenger">未確認の種別を営業に設定</button></div>
      <div class="fields">
        <label>最低乗換時間（秒）<input name="minimum-transfer-seconds" type="number" min="1" step="1" required value="${d.minimumTransferSeconds ?? defaultLineTransferSeconds}" aria-describedby="minimum-transfer-hint"></label>
        <label>乗車上限の混雑率（%）<input name="boarding-limit-percent" type="number" min="0" step="any" value="${d.boardingLimitPercent ?? ""}" placeholder="例：150" aria-describedby="boarding-limit-hint"></label>
      </div>
      <p id="minimum-transfer-hint" class="muted">乗換案内・混雑推計の全日区分に共通です。駅構内の移動に時間がかかる場合は値を大きくしてください。</p>
      <p id="boarding-limit-hint" class="muted">乗車上限は全日区分で共通です。空欄なら上限なし。指定の混雑率に達すると、乗り切れない利用者は目的地へ行ける後続便を待ちます。</p>
      ${formationFields(p)}
      ${formationSectionFields(p, dia)}
      <div class="table-scroll"><table><thead><tr><th scope="col">列車種別</th><th scope="col">営業区分</th><th scope="col">輸送定員（人／編成）</th><th scope="col">編成両数</th></tr></thead>
      <tbody>${p.types
        .map((t, i) => {
          const state = p.serviceClasses?.types[t.id]?.state ?? "review";
          const capacity = p.capacitySettings?.types[t.id];
          return `<tr><th scope="row">${e(t.name)}</th><td><select name="class${i}" aria-label="${e(t.name)}の営業区分">${options(classOptions, state)}</select></td>
        <td>${num("cap" + i, capacity?.kind === "transport" ? capacity.value : capacity ? undefined : p.typeCapacities?.[t.id], t.name + "の輸送定員", "1")}</td>
        <td>${num("type-cars" + i, t.carCount ?? capacity?.carCount, t.name + "の編成両数", "1", 1)}</td></tr>`;
        })
        .join("")}</tbody></table></div>
      <div class="fields single-field"><label>ダイヤ共通の輸送定員（人／編成、任意）${num("default-cap", p.capacitySettings?.timetables[dia.id]?.kind === "transport" ? p.capacitySettings.timetables[dia.id].value : undefined, "ダイヤ共通の輸送定員", "1")}</label></div>
      <details><summary>列車別の設定（${n(dia.trains.length, 0)}本）</summary>
        <label class="train-filter">列車番号・種別・運用番号で絞り込む<input type="search" id="train-filter"></label>
        <div class="table-scroll train-config"><table><thead><tr><th scope="col">列車</th><th scope="col">営業区分</th><th scope="col">輸送定員（人／編成）</th><th scope="col">編成両数</th></tr></thead>
        <tbody>${dia.trains
          .map((t, i) => {
            const key = trainClassKey(dia.id, t.id);
            const own = p.capacitySettings?.trains[key];
            const resolved = capacityForTrain(p, dia.id, t).spec;
            const name = t.number || t.id;
            const type = p.types.find(({ id }) => id === t.typeId)?.name ?? "";
            const { numbers, group, inheritedFrom } = operationGroup(p, t);
            return `<tr data-train-row="${e([name, type, ...numbers, group].join(" "))}"><th scope="row">${e(name)} <small>${e(type)}・${t.direction === "down" ? "下り" : "上り"}</small>${numbers.length ? `<small>運用 ${e(numbers.join("、"))}${group ? ` ／ <code>${e(group)}</code>` : ""}${inheritedFrom ? `（前列車 ${e(inheritedFrom.number || inheritedFrom.id)} から継承）` : ""}</small>` : ""}</th>
          <td><select name="train-class${i}" aria-label="${e(name)}の営業区分">${options([{ id: "", name: "種別に従う" }, ...classOptions], p.serviceClasses?.trains[key]?.state ?? "")}</select></td>
          <td>${num("train-cap" + i, own?.kind === "transport" ? own.value : own ? undefined : t.capacity, name + "の輸送定員", "1")}<small class="muted" data-capacity-hint>${!own && resolved?.kind === "transport" && t.capacity === undefined ? `継承値 ${n(resolved.value, 0)} 人` : ""}</small></td>
          <td>${num("cars" + i, own?.carCount, name + "の編成両数", "1")}</td></tr>`;
          })
          .join("")}</tbody></table></div>
      </details>
    </section>
    <div class="save-bar"><button type="submit" class="primary">設定を保存</button><div class="save-feedback"><span id="form-state" class="muted" aria-live="polite"></span><span id="form-save-error" role="alert"></span></div></div>
  </form>`;
}

const classOptions = Object.entries(classLabels).map(([id, name]) => ({
  id,
  name,
}));

export function readDemand(
  form: HTMLFormElement,
  p: Project,
  dia: Timetable,
): LineDemand {
  const fields = new FormData(form);
  const str = (key: string) => String(fields.get(key) ?? "");
  const base = lineDemandForDay(p);
  const timing = str("demand-time-mode");
  const byArrival = timing === "arrival";
  const shares: LineDemand["shares"] =
    timing === "boarding"
      ? { local: periods.map((_, i) => Number(str("local" + i))) }
      : base.shares;
  if (timing === "boarding")
    for (const flow of ["inbound", "outbound"] as const)
      if (fields.has("override-" + flow))
        shares[flow] = periods.map((_, i) => Number(str(flow + i)));
  const destinationArrival = byArrival
    ? {
        enabled: true,
        smooth: fields.has("arrival-smooth"),
        shares: {
          up: Array.from({ length: arrivalHourCount }, (_, i) =>
            Number(str("arr-hour-up-" + i)),
          ),
          down: Array.from({ length: arrivalHourCount }, (_, i) =>
            Number(str("arr-hour-down-" + i)),
          ),
        },
      }
    : base.destinationArrival && { ...base.destinationArrival, enabled: false };
  const outside = Array.from(
    form.querySelectorAll<HTMLElement>("[data-area]"),
  ).map((el): OutsideArea => {
    const field = (name: string) =>
      el.querySelector<HTMLInputElement | HTMLSelectElement>(
        `[name="${name}"]`,
      )!;
    const id = el.dataset.area!;
    const old = base.outside.find((a) => a.id === id);
    const stationId = field("area-station").value;
    const mode = field("area-mode").value as OutsideArea["mode"];
    const trains =
      mode === "through" && old && old.stationId === stationId
        ? { ...old.trains }
        : {};
    const selected = (name: string) =>
      Array.from((field(name) as HTMLSelectElement).selectedOptions).map(
        (v) => v.value,
      );
    if (mode === "through")
      trains[dia.id] = {
        inbound: selected("trains-in"),
        outbound: selected("trains-out"),
      };
    return {
      id,
      stationId,
      mode,
      name: field("area-name").value.trim(),
      inbound: Number(field("area-in").value),
      outbound: Number(field("area-out").value),
      included: (field("area-included") as HTMLInputElement).checked,
      trains,
    };
  });
  const counts = Object.fromEntries(
    p.stations.flatMap((s, i) =>
      str("board" + i) || str("alight" + i)
        ? [
            [
              s.id,
              {
                board: Number(str("board" + i)),
                alight: Number(str("alight" + i)),
                weight: Number(str("weight" + i) || 1),
              },
            ],
          ]
        : [],
    ),
  );
  const stationProfiles = Object.fromEntries(
    p.stations.flatMap((s, i) => {
      const primary = str(`station-primary-${i}`) as StationAttribute | "";
      const secondary = str(`station-secondary-${i}`) as StationAttribute | "";
      const entries = tripPurposes.map(
        (purpose) => [purpose, str(`station-${purpose}-${i}`)] as const,
      );
      const shares = entries.some(([, value]) => value !== "")
        ? (Object.fromEntries(
            entries.map(([purpose, value]) => [
              purpose,
              value === "" ? NaN : Number(value),
            ]),
          ) as PurposeShares)
        : undefined;
      if (!primary && !secondary && !shares) return [];
      const profile: StationDemandProfile = {
        ...(primary && { primary }),
        ...(secondary && { secondary }),
        ...(shares && { shares }),
      };
      return [[s.id, profile] as const];
    }),
  );
  const limit = str("boarding-limit-percent").trim();
  return {
    counts,
    ...(Object.keys(stationProfiles).length > 0 && { stationProfiles }),
    ...(timing === "profile" && { stationProfileTiming: true }),
    shares,
    outside,
    minimumTransferSeconds: Number(str("minimum-transfer-seconds")),
    ...(limit !== "" && { boardingLimitPercent: Number(limit) }),
    ...(destinationArrival && { destinationArrival }),
  };
}

export function applyTrainSettings(
  form: HTMLFormElement,
  p: Project,
  dia: Timetable,
) {
  const fields = new FormData(form);
  const picked = (key: string) => String(fields.get(key) ?? "");
  const classes = (p.serviceClasses ??= { types: {}, trains: {} });
  const caps = (p.capacitySettings ??= {
    timetables: {},
    trains: {},
    types: {},
  });
  const basis = "データ設定で登録";
  const mode = picked("formation-source");
  if (mode === "legacy") delete caps.formationSource;
  else if (mode === "type" || mode === "operation") caps.formationSource = mode;
  const writeClass = (
    target: typeof classes.types,
    id: string,
    value: string,
  ) => {
    if (!value) delete target[id];
    else if (target[id]?.state !== value)
      Object.defineProperty(target, id, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: { state: value as ServiceClass, basis },
      });
  };
  const writeCap = (
    target: typeof caps.types,
    id: string,
    field: string,
    cars?: number,
  ) => {
    const value = Number(picked(field));
    const current = Object.hasOwn(target, id) ? target[id] : undefined;
    if (value > 0) {
      if (
        current?.kind === "transport" &&
        current.value === value &&
        current.carCount === cars
      )
        return;
      Object.defineProperty(target, id, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: {
          kind: "transport",
          value,
          basis,
          ...(cars && { carCount: cars }),
        },
      });
    } else if (current?.kind === "transport") delete target[id];
  };
  p.types.forEach((t, i) => {
    writeClass(classes.types, t.id, picked("class" + i));
    const cars = picked("type-cars" + i);
    if (cars) t.carCount = Number(cars);
    else delete t.carCount;
    // Move older type-level formation metadata into the editable type itself.
    if (caps.types[t.id]?.carCount !== undefined)
      delete caps.types[t.id].carCount;
    if (!picked("cap" + i) && p.typeCapacities) delete p.typeCapacities[t.id];
    writeCap(caps.types, t.id, "cap" + i);
  });
  writeCap(caps.timetables, dia.id, "default-cap");
  if (mode === "operation") {
    const provisional = picked("ungrouped-operation-capacity");
    if (provisional) caps.ungroupedOperationCapacity = Number(provisional);
    else delete caps.ungroupedOperationCapacity;
    const values = (caps.operationGroups ??= {});
    const counts = (caps.operationGroupCars ??= {});
    operationGroups(p).groups.forEach(([id], i) => {
      const cars = Number(picked("group-cars" + i)) || undefined;
      const hasCapacity = !!picked("group-cap" + i);
      writeCap(values, id, "group-cap" + i, cars);
      if (!hasCapacity && cars) counts[id] = cars;
      else delete counts[id];
      if (!hasCapacity && values[id]?.carCount !== undefined) delete values[id].carCount;
    });
    if (!Object.keys(values).length) delete caps.operationGroups;
    if (!Object.keys(counts).length) delete caps.operationGroupCars;
  }
  dia.trains.forEach((t, i) => {
    const key = trainClassKey(dia.id, t.id);
    if (hasFormationChanges(t) && !t.cancelled) {
      const sections = Object.fromEntries(formationStages(t).flatMap(({ stop }, si) => {
        const values: FormationValues = {};
        const cap = picked("formation-cap-" + i + "-" + si);
        const count = picked("formation-cars-" + i + "-" + si);
        if (cap !== "") values.capacity = Number(cap);
        if (count !== "") values.carCount = Number(count);
        return cap !== "" || count !== "" ? [[formationPosition(stop), values]] : [];
      }));
      if (Object.keys(sections).length) (caps.formationSections ??= {})[key] = sections;
      else if (caps.formationSections) delete caps.formationSections[key];
    }
    const cars = Number(picked("cars" + i)) || undefined;
    if (cars && !Number(picked("train-cap" + i)))
      throw new Error(
        `列車 ${t.number || t.id} の編成両数を登録するには、その列車の輸送定員も入力してください`,
      );
    writeClass(classes.trains, key, picked("train-class" + i));
    if (!picked("train-cap" + i)) delete t.capacity;
    writeCap(caps.trains, key, "train-cap" + i, cars);
  });
}
