import "./style.css";
import "./journey.css";
import "./assignment.css";
import { validateProject, type Project, type Parameters } from "./model";
import { sampleProject } from "./sample";
import {
  clock,
  directTrains,
  expectedWait,
  headways,
  stationDepartures,
  trainVisits,
} from "./analysis";
import { generateDemand, timetableCosts } from "./demand";
import { parseOud2 } from "./oud2";
import { decodeOud2 } from "./oud2-text";
import {
  loadProject,
  saveProject,
  loadWorkspace,
  saveWorkspace,
} from "./storage";
import { workspace, registerProject, validateWorkspace } from "./workspace";
import {
  renderRouting,
  routeClick,
  routeChange,
  routeInput,
  refreshRoute,
} from "./routing-ui";
import { renderTemporal, temporalClick, temporalChange } from "./temporal-ui";
import {
  renderClassification,
  classClick,
  classChange,
} from "./classification-ui";
import {
  renderAssignment,
  assignmentClick,
  assignmentChange,
} from "./assignment-ui";
import { classificationCounts } from "./classification";
import type { UIContext } from "./ui-utils";
import {
  download,
  csv,
  stationCsv,
  importStationCsv,
  demandCsv,
  importDemandCsv,
} from "./io";

const app = document.querySelector<HTMLDivElement>("#app")!;
let p = sampleProject(),
  page = 0,
  diaId = p.timetables[0].id,
  origin = p.stations[0].id,
  destination = p.stations.at(-1)!.id,
  direction = "",
  typeId = "",
  start = 7,
  end = 9,
  costMode = "manual",
  importEncoding = "auto",
  importDayStart = "file",
  storageWarning = "",
  message = "",
  warnings: string[] = [];
let saveTicket = 0;
const names = [
  "ダッシュボード",
  "ダイヤデータ管理",
  "ダイヤ分析",
  "駅・沿線都市",
  "OD需要推計",
  "OD行列・出力",
  "経路検索",
  "時間帯別OD",
  "営業区分・定員",
  "旅客配分・混雑分析",
];
const icons = ["▦", "⇅", "⌁", "◎", "↗", "▤", "⇢", "◷", "◇", "▥"];
function uiContext(): UIContext {
  return {
    project: p,
    diaId,
    projects: workspace.projects,
    links: workspace.transferLinks,
    save,
    render,
    activate: (id) => {
      const next = workspace.projects.find((x) => x.datasetId === id);
      if (!next) throw new Error("データセットがありません");
      replace(next);
      render();
    },
    message: (s) => {
      message = s;
    },
  };
}
const purposeNames = {
  commute: "通勤",
  school: "通学",
  shopping: "買物",
  private: "その他私事",
};
const esc = (v: unknown) =>
  String(v).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const fmt = (n: number | null | undefined, d = 1) =>
  n == null ? "—" : n.toLocaleString("ja-JP", { maximumFractionDigits: d });
const dia = () => p.timetables.find((d) => d.id === diaId)!;
const options = (arr: { id: string; name: string }[], selected: string) =>
  arr
    .map(
      (x) =>
        `<option value="${esc(x.id)}" ${x.id === selected ? "selected" : ""}>${esc(x.name)}</option>`,
    )
    .join("");
const select = (id: string, label: string, inner: string) =>
  `<label>${label}<select id="${id}">${inner}</select></label>`;
const num = (id: string, label: string, value: number, min = 0, step = "any") =>
  `<label>${label}<input id="${id}" type="number" min="${min}" step="${step}" value="${value}" required></label>`;
const button = (action: string, text: string, cls = "") =>
  `<button data-action="${action}" class="${cls}">${text}</button>`;
const card = (label: string, value: string, unit: string, note: string) =>
  `<article class="metric"><span>${label}</span><strong>${value}<small>${unit}</small></strong><p>${note}</p></article>`;
const table = (headers: string[], rows: string[][], cls = "") =>
  `<div class="table-wrap"><table class="${cls}"><thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
const panel = (title: string, sub: string, body: string) =>
  `<section class="panel"><div class="panel-heading"><h2>${title}</h2><p>${sub}</p></div>${body}</section>`;
const file = (kind: string, label: string, accept: string) =>
  `<label class="file-button">${label}<input type="file" data-file="${kind}" accept="${accept}"></label>`;
function save() {
  const ticket = ++saveTicket;
  storageWarning = "ブラウザに保存中です。完了まで再読み込みをお待ちください";
  registerProject(p);
  void Promise.all([saveProject(p), saveWorkspace(workspace)])
    .then(() => {
      if (ticket !== saveTicket) return;
      storageWarning = "";
      refreshStorageNotice();
    })
    .catch(() => {
      if (ticket !== saveTicket) return;
      storageWarning =
        "ブラウザ保存の容量上限等により保存できませんでした。現在のデータは画面内にありますが、再読み込み前にプロジェクトJSONを保存してください";
      refreshStorageNotice();
    });
}
function refreshStorageNotice() {
  app.querySelector("#storage-notice")?.remove();
  if (storageWarning)
    app
      .querySelector("main > header")
      ?.insertAdjacentHTML(
        "afterend",
        `<div id="storage-notice" class="notice" role="alert">${esc(storageWarning)}</div>`,
      );
}
async function restore() {
  try {
    const storedWorkspace = await loadWorkspace();
    if (storedWorkspace) Object.assign(workspace, storedWorkspace);
    const data = await loadProject();
    if (data) {
      p = data;
      warnings = p.oud2?.warnings ?? [];
      resetSelection();
    }
  } catch {
    message = "保存データが不正なためサンプルを表示しています";
  }
  registerProject(p);
  render();
}
function resetSelection() {
  diaId = p.timetables[0].id;
  origin = p.stations[0].id;
  destination = p.stations.at(-1)!.id;
  direction = "";
  typeId = "";
}
function replace(next: Project) {
  validateProject(next);
  p = next;
  registerProject(p);
  warnings = p.oud2?.warnings ?? [];
  resetSelection();
  save();
}
function filters() {
  return `<div class="filters">${select("origin", "出発駅", options(p.stations, origin))}${select("destination", "到着駅", options(p.stations, destination))}${select("direction", "方向", '<option value="">全方向</option><option value="down" ' + (direction === "down" ? "selected" : "") + '>下り</option><option value="up" ' + (direction === "up" ? "selected" : "") + ">上り</option>")}${select("typeId", "列車種別", '<option value="">全種別</option>' + options(p.types, typeId))}${num("start", "開始時刻（時）", start, 0)}${num("end", "終了時刻（時）", end, 0)}</div>`;
}
function dashboard() {
  const deps = stationDepartures(dia(), origin, "", "");
  const h = headways(deps);
  const total = p.demands.reduce((a, d) => a + d.passengers, 0);
  return `<div class="hero"><div><span class="eyebrow">LOCAL RAILWAY INTELLIGENCE</span><h2>ダイヤと都市を、<br>数字でつなぐ。</h2><p>運行サービスと沿線の需要を、一つのワークスペースで。</p>${button("analyze", "ダイヤを分析する →", "primary")}</div><div class="route-art" aria-label="路線概略">${p.stations.map((s, i) => `<div><b>${String(i + 1).padStart(2, "0")}</b><i></i><span>${esc(s.name)}</span></div>`).join("")}</div></div><div class="metrics">${card("路線内の駅数", fmt(p.stations.length, 0), "駅", "駅IDでダイヤと都市データを連携")}${card("登録列車", fmt(dia().trains.length, 0), "本", esc(dia().name) + "・両方向")}${card("平均運転間隔", fmt(h?.mean), "分", esc(p.stations.find((s) => s.id === origin)!.name) + "・全方向／全種別・全時刻")}${card("登録OD需要", fmt(total, 0), "人", "推計・実測・手動はOD画面で区別")}</div><div class="two-col">${panel("時間帯別運行本数", "選択ダイヤ・全列車／最初の発時刻で集計", hourChart())}${panel("分析の進め方", "サンプルは架空の5駅・72列車です", `<ol class="steps"><li><b>ダイヤを確認</b><span>サンプルまたは対応ファイルを読み込み</span></li><li><b>沿線都市を設定</b><span>人口・雇用・学生・鉄道利用率を入力</span></li><li><b>OD需要を推計</b><span>係数と所要時間を設定し需要を生成</span></li></ol><div class="notice">経路検索・時間帯別ODを追加しました。旅客配分・混雑分析を追加しました。積み残し・改正比較は未対応です。</div>`)}</div>`;
}
function hourChart() {
  const bins = new Map<number, number>();
  for (const t of dia().trains) {
    if (t.cancelled) continue;
    const dep = t.stops.find((s) => s.departure !== undefined)?.departure;
    if (dep !== undefined) {
      const h = Math.floor(dep / 3600);
      bins.set(h, (bins.get(h) ?? 0) + 1);
    }
  }
  if (!bins.size) return "<p>発時刻がありません</p>";
  const max = Math.max(...bins.values());
  return `<div class="bars">${[...bins]
    .sort((a, b) => a[0] - b[0])
    .map(
      ([h, n]) =>
        `<div class="bar-col"><span>${n}</span><div style="height:${Math.max(2, (n / max) * 120)}px"></div><small>${h}時</small></div>`,
    )
    .join("")}</div>`;
}
function management() {
  return panel(
    "データの読み込み・保存",
    "処理はブラウザ内で完結します。読み込み失敗時は現在のデータを保持します。",
    `<div class="actions">${file("oud2", ".oud2 を読み込む", ".oud2")}${select("encoding", "OuDia2nd文字コード", '<option value="auto">自動（UTF-8 → Shift_JIS）</option><option value="shift_jis">Shift_JIS</option><option value="utf-8">UTF-8</option>'.replace(`value="${importEncoding}"`, `value="${importEncoding}" selected`))}${select(
      "importDayStart",
      "解析運行日の起点",
      [
        { id: "file", name: "ファイルの起点に合わせる" },
        { id: "0", name: "00:00（繰り上げなし）" },
        { id: "10800", name: "03:00" },
        { id: "14400", name: "04:00" },
      ]
        .map(
          (x) =>
            `<option value="${x.id}" ${importDayStart === x.id ? "selected" : ""}>${x.name}</option>`,
        )
        .join(""),
    )}${file("json", "JSONを読み込む", ".json")}${button("json", "プロジェクトJSON保存")}${button("sample", "架空鉄道サンプルに切替")}${button("workspaceJson", "全データセットJSON保存")}</div><div class="notice">.oud2：FileType 1.07 / 1.17に部分対応。明示された分岐駅は同一駅IDへ統合し、路線外発着は境界駅別に保持します。解析起点未満の時刻は翌日へ繰り上げます（ファイル起点がなければ00:00）。欠損時刻は補完しません。環状線・増解結・未知の列車条件は停止します。</div><h3>登録ダイヤ</h3>${table(
      ["ダイヤ名", "列車数", "方向"],
      p.timetables.map((d) => [
        esc(d.name),
        fmt(d.trains.length, 0),
        "下り / 上り",
      ]),
    )}${importDetails()}<h3>CSV入出力</h3><div class="actions">${button("stationsCsv", "駅CSV出力")}${file("stations", "駅CSV読込", ".csv")}${button("odCsv", "OD CSV出力")}${file("od", "OD CSV読込", ".csv")}</div><p class="muted">CSVは出力したヘッダー・列順を使用。駅IDは既存ダイヤと整合する必要があります。ダイヤ・係数・時間行列・路線外発着・原時刻／作業はプロジェクトJSONで保存します。元の.oud2への書き戻しは未対応です。</p>`,
  );
}
function externalLabel(
  t: Project["timetables"][number]["trains"][number],
  side: "origin" | "destination",
) {
  const endpoint = side === "origin" ? t.externalOrigin : t.externalDestination;
  if (!endpoint) return "—";
  const terminal = p.oud2?.externalTerminals.find(
    (x) => x.id === endpoint.terminalId,
  );
  return `${esc(terminal?.name ?? endpoint.terminalId)}<small class="block">${endpoint.externalTime === undefined ? "時刻なし" : clock(endpoint.externalTime)} ${side === "origin" ? "発" : "着"}</small>`;
}
function importDetails() {
  const meta = p.oud2;
  if (!meta) return "";
  const trains = dia().trains.filter(
    (t) => t.externalOrigin || t.externalDestination,
  );
  return `<h3>読み込み内訳</h3><p class="muted">${esc(meta.fileType)} / ${esc(meta.encoding ?? "文字コード記録なし")} / 解析起点 ${clock(meta.serviceDayStart)} / 時刻表 ${meta.positions.length}行 → 路線内 ${p.stations.length}駅 / 空欄列 ${meta.emptyColumns}件を除外（全ダイヤ合計）</p><p class="notice">集計は登録種別を対象にします。回送・試運転等も含まれ、旅客営業は名前から推測しません。運休扱いは解析から除外。作業による次列車接続・種別変更をまたぐ旅客直通は未対応です。</p><details><summary>分岐・基幹駅の対応</summary>${table(
    ["時刻表行", "表示名", "路線内駅ID", "基幹行"],
    meta.positions
      .filter((x) => x.branchCorePositionId)
      .map((x) => [
        esc(x.id),
        esc(x.name),
        esc(x.stationId),
        esc(x.branchCorePositionId),
      ]),
  )}</details><h3>路線外発着の定義（境界駅別）</h3>${table(
    ["境界駅", "路線外発着名", "ID"],
    meta.externalTerminals.map((x) => [
      esc(p.stations.find((s) => s.id === x.boundaryStationId)!.name),
      esc(x.name),
      esc(x.id),
    ]),
  )}<h3>路線外へ直通する列車（選択ダイヤ）</h3><p class="muted">路線外駅はODの対象外です。境界時刻の不一致は警告に記録し、路線内解析にはEkiJikokuの明示値を使用します。</p>${table(
    [
      "列車番号 / 参照ID",
      "種別",
      "路線外始発",
      "路線内区間",
      "路線外終着",
      "原作業",
    ],
    trains.map((t) => {
      const visits = trainVisits(t);
      const first = p.stations.find((s) => s.id === visits[0]?.stationId),
        last = p.stations.find((s) => s.id === visits.at(-1)?.stationId);
      return [
        esc(t.number || "（番号なし）") +
          `<small class="block">${esc(t.id)}</small>`,
        esc(p.types.find((x) => x.id === t.typeId)!.name),
        externalLabel(t, "origin"),
        `${esc(first?.name)} → ${esc(last?.name)}`,
        externalLabel(t, "destination"),
        esc(
          [t.externalOrigin?.raw, t.externalDestination?.raw]
            .filter(Boolean)
            .join(" / "),
        ),
      ];
    }),
  )}`;
}
function analysis() {
  const chosen = {
    ...dia(),
    trains: dia().trains.filter(
      (t) =>
        (!direction || t.direction === direction) &&
        (!typeId || t.typeId === typeId),
    ),
  };
  const rows = directTrains(chosen, origin, destination);
  const displayed = rows.filter(
    (r) => r.departure >= start * 3600 && r.departure < end * 3600,
  );
  const deps = stationDepartures(
    chosen,
    origin,
    "",
    "",
    start * 3600,
    end * 3600,
  );
  const h = headways(deps);
  const wait =
    end > start ? expectedWait(rows, start * 3600, end * 3600) : null;
  return (
    filters() +
    `<div class="metrics">${card("出発駅の発車本数", fmt(deps.length, 0), "本", "指定時間帯・停車のみ／終着は除外")}${card("OD直通 / 有効", displayed.length + " / " + displayed.filter((r) => r.effective).length, "本", "有効判定は時間窓外の後続列車も考慮")}${card("期待待ち時間", fmt(wait?.minutes), "分", "最速到着選択・利用可能時間に条件付け")}${card("利用可能な到着時間割合", fmt(wait ? wait.coverage * 100 : null), "%", "指定窓に一様に到着する旅客")}</div><div class="two-col">${panel("運転間隔", "指定駅・方向・種別・時間窓の発車時刻差。標準偏差は母標準偏差。", table(["平均", "中央値", "最大", "標準偏差"], [[fmt(h?.mean) + " 分", fmt(h?.median) + " 分", fmt(h?.max) + " 分", fmt(h?.sd) + " 分"]]))}${panel(
      "駅別・方向別・種別別の発車本数",
      "指定時間帯。上部の方向・種別フィルターを適用。",
      table(
        ["駅", "下り", "上り"],
        p.stations.map((s) => [
          esc(s.name),
          fmt(
            direction === "up"
              ? 0
              : stationDepartures(
                  chosen,
                  s.id,
                  "down",
                  "",
                  start * 3600,
                  end * 3600,
                ).length,
            0,
          ),
          fmt(
            direction === "down"
              ? 0
              : stationDepartures(
                  chosen,
                  s.id,
                  "up",
                  "",
                  start * 3600,
                  end * 3600,
                ).length,
            0,
          ),
        ]),
      ),
    )}</div>${panel(
      "直通列車一覧",
      "着発時刻が明示された停車駅間のみ。通過駅での乗降は扱いません。",
      table(
        [
          "列車番号",
          "種別",
          "出発",
          "到着",
          "所要時間",
          "最速到着基準",
          "路線外始発",
          "路線外終着",
        ],
        displayed.map((r) => [
          esc(r.train.number),
          esc(p.types.find((t) => t.id === r.train.typeId)!.name),
          clock(r.departure),
          clock(r.arrival),
          fmt((r.arrival - r.departure) / 60) + " 分",
          `<span class="tag ${r.effective ? "green" : ""}">${r.effective ? "有効" : "後続が優位"}</span>`,
          externalLabel(r.train, "origin"),
          externalLabel(r.train, "destination"),
        ]),
      ),
    )}${panel(
      "時間帯別発車本数",
      "出発駅・選択方向／種別。24時以降も区別して表示。",
      table(
        ["時間帯", "本数"],
        [
          ...new Set(
            stationDepartures(chosen, origin, "", "").map((t) =>
              Math.floor(t / 3600),
            ),
          ),
        ]
          .sort((a, b) => a - b)
          .map((h) => [
            `${h}:00–${h + 1}:00`,
            fmt(
              stationDepartures(
                chosen,
                origin,
                "",
                "",
                h * 3600,
                (h + 1) * 3600,
              ).length,
              0,
            ),
          ]),
      ),
    )}${panel(
      "駅間所要時間",
      "分岐を考慮した接続駅間。選択方向・種別・時間窓に合う直通列車の最短乗車時間。",
      table(
        ["区間", "下り最短", "上り最短"],
        (
          p.oud2?.links ??
          p.stations
            .slice(0, -1)
            .map((s, i) => ({ from: s.id, to: p.stations[i + 1].id }))
        ).map((link) => {
          const s = p.stations.find((s) => s.id === link.from)!,
            d = p.stations.find((s) => s.id === link.to)!;
          const duration = (a: string, b: string) => {
            const rs = directTrains(chosen, a, b).filter(
              (r) => r.departure >= start * 3600 && r.departure < end * 3600,
            );
            return rs.length
              ? fmt(
                  Math.min(...rs.map((r) => (r.arrival - r.departure) / 60)),
                ) + " 分"
              : "—";
          };
          return [
            esc(s.name) + " ↔ " + esc(d.name),
            duration(s.id, d.id),
            duration(d.id, s.id),
          ];
        }),
      ),
    )}<p class="muted">時間窓の終了後に出発する列車も、待機可能な候補に含みます。翌日の便の繰り返しは仮定しません。この画面は直通ODを分析します。乗換を含む分析は「経路検索」を利用してください。同一駅の移動・欠損時刻の補完は扱いません。</p>`
  );
}
function city() {
  const cols = [
    ["population", "人口"],
    ["employment", "雇用"],
    ["students", "学生数"],
    ["attraction", "商業・観光指標"],
    ["railShare", "鉄道利用率（0〜1）"],
  ] as const;
  return panel(
    "駅と沿線都市の設定",
    "発生需要には人口、目的地の吸引力には雇用・学生・商業指標を使います。",
    `<div class="actions">${button("stationsCsv", "駅CSV出力")}${file("stations", "駅CSV読込", ".csv")}</div>${table(
      ["駅ID / 駅名", ...cols.map((c) => c[1])],
      p.stations.map((s) => [
        `<b>${esc(s.name)}</b><small class="block">${esc(s.id)} / ${esc(s.section)}</small>`,
        ...cols.map(
          ([k, label]) =>
            `<input aria-label="${esc(s.name)} ${label}" data-station="${esc(s.id)}" data-key="${k}" type="number" min="0" ${k === "railShare" ? 'max="1" step="0.01"' : 'step="any"'} value="${s[k]}" required>`,
        ),
      ]),
    )}<p class="muted">商業・観光指標は任意の相対単位。全駅で単位を揃えてください。駅名・所属・乗換駅IDはJSONまたは駅CSVで編集できます。</p>`,
  );
}
function estimation() {
  const q = p.parameters;
  const result = generateDemand(
    p,
    costMode === "manual" ? p.costs : timetableCosts(p, diaId),
  );
  return (
    panel(
      "重力モデルによる需要推計",
      "発生交通量を各目的地の吸引力と移動負担で配分する、発生制約型モデル。",
      `<div class="formula">T<sub>ij</sub> = O<sub>i</sub> × A<sub>j</sub> e<sup>−βCᵢⱼ</sup> / Σ<sub>k≠i</sub> A<sub>k</sub> e<sup>−βCᵢₖ</sup></div><div class="filters">${select(
        "purpose",
        "移動目的",
        Object.entries(purposeNames)
          .map(
            ([id, name]) =>
              `<option value="${id}" ${q.purpose === id ? "selected" : ""}>${name}</option>`,
          )
          .join(""),
      )}<label>需要時間帯ラベル<input id="period" value="${esc(q.period)}" required></label>${num("generation", "発生係数（人/人口/時間帯）", q.generation)}${num("beta", "抵抗係数 β（1/分）", q.beta)}${num("employmentWeight", "雇用の吸引係数", q.employmentWeight)}${num("studentWeight", "学生の吸引係数", q.studentWeight)}${num("attractionWeight", "商業・観光の吸引係数", q.attractionWeight)}${select("costMode", "移動負担 C（分）", `<option value="manual" ${costMode === "manual" ? "selected" : ""}>手動の時間行列</option><option value="timetable" ${costMode === "timetable" ? "selected" : ""}>選択ダイヤの最短直通時間</option>`)}</div><p class="muted">Oᵢ = 人口 × 鉄道利用率 × 発生係数。Aⱼ = 雇用 × 雇用係数 + 学生数 × 学生係数 + 商業指標 × 商業係数。時間帯はラベルであり、時間分布はまだ計算しません。</p><div class="metrics">${card("設定発生量", fmt(result.generated), "人", esc(q.period))}${card("配分可能量", fmt(result.allocated), "人", "計算は丸め前の実数値")}${card("未配分", fmt(result.unallocated), "人", "吸引先・移動負担の欠損を確認")}</div>${result.warnings.map((w) => `<p class="notice">${esc(w)}</p>`).join("")}<div class="actions">${button("generate", "この条件でOD需要を生成", "primary")}</div><p class="muted">生成すると登録済みODを置換します。既存データが必要な場合はJSONまたはCSVで保存してください。結果の出典はすべて「推計値」です。</p>`,
    ) +
    panel(
      "手動の所要時間行列",
      "分単位・方向別。空欄は未設定（到達不可扱い）。対角は配分対象外。ダイヤモードではこの行列を使用しません。",
      table(
        ["発 ＼ 着", ...p.stations.map((s) => esc(s.name))],
        p.stations.map((o) => [
          esc(o.name),
          ...p.stations.map((d) =>
            o.id === d.id
              ? "—"
              : `<input type="number" min="0" step="any" data-cost-origin="${esc(o.id)}" data-cost-destination="${esc(d.id)}" value="${p.costs[o.id]?.[d.id] ?? ""}" aria-label="${esc(o.name)}から${esc(d.name)}の分数">`,
          ),
        ]),
      ),
    )
  );
}
function matrix() {
  const rows = p.stations.map((o) => [
    esc(o.name),
    ...p.stations.map((d) => {
      if (o.id === d.id) return '<span class="muted">—</span>';
      const n = p.demands
        .filter((r) => r.origin === o.id && r.destination === d.id)
        .reduce((a, r) => a + r.passengers, 0);
      return `<span class="heat" style="background:rgba(9,133,113,${Math.min(0.8, n / 2500) + 0.04})">${fmt(n)}</span>`;
    }),
    fmt(
      p.demands
        .filter((r) => r.origin === o.id)
        .reduce((a, r) => a + r.passengers, 0),
    ),
  ]);
  return (
    panel(
      "OD行列",
      "人数。下表は全目的・時間帯・出典を合算。明細で区別できます。",
      `<div class="actions">${button("matrixCsv", "行列CSV出力")}${button("odCsv", "OD明細CSV出力")}${file("od", "OD CSV読込", ".csv")}</div>${p.demands.length ? "" : '<p class="notice">OD需要は未登録です。「OD需要推計」で生成してください。</p>'}${table(["発 ＼ 着", ...p.stations.map((s) => esc(s.name)), "合計"], rows, "matrix")}<p>総量：<b>${fmt(p.demands.reduce((a, r) => a + r.passengers, 0))} 人</b>　対角は0。CSVは丸め前の人数を保存します。</p>`,
    ) +
    panel(
      "需要明細・出典",
      "推計・実測・手動を区別して保持します。実測によるモデル補正は未対応です。",
      table(
        ["発駅 → 着駅", "目的", "時間帯", "人数", "出典"],
        p.demands.map((d) => [
          esc(p.stations.find((s) => s.id === d.origin)!.name) +
            " → " +
            esc(p.stations.find((s) => s.id === d.destination)!.name),
          purposeNames[d.purpose],
          esc(d.period),
          fmt(d.passengers),
          `<span class="tag ${d.source === "estimated" ? "" : "green"}">${{ estimated: "推計値", observed: "実測値", manual: "手動設定値" }[d.source]}</span>`,
        ]),
      ),
    )
  );
}
function render() {
  app.innerHTML = `<aside><a class="brand" href="#"><span class="logo">R<span>↗</span></span><span>Railway Lab<small>ダイヤ・OD需要分析</small></span></a><div class="workspace-label">WORKSPACE</div><nav aria-label="メインメニュー">${names.map((n, i) => `<button data-page="${i}" class="${page === i ? "active" : ""}"><span>${icons[i]}</span>${n}</button>`).join("")}</nav><div class="sidebar-bottom"><span class="status-dot"></span> ブラウザ内で処理<small>MVP 0.3 / ローカル保存</small></div></aside><main><header><div><div class="breadcrumb">ワークスペース <span>/ ${names[page]}</span></div><h1>${names[page]}</h1></div><div class="project-select"><span class="tag green">ローカル</span>${select("diaId", esc(p.name), options(p.timetables, diaId))}</div></header>${message ? `<div class="notice" role="status">${esc(message)} ${button("dismiss", "閉じる")}</div>` : ""}${warnings.length ? `<details class="notice"><summary>読み込みの警告・制限 ${warnings.length}件（部分対応）</summary><ul>${warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></details>` : ""}${[dashboard, management, analysis, city, estimation, matrix, () => renderRouting(uiContext()), () => renderTemporal(uiContext()), () => renderClassification(uiContext()), () => renderAssignment(uiContext())][page]()}<footer>Railway Lab · ブラウザ内の分析プロトタイプ <span>単位：時刻＝運行日基準 / 所要時間＝分 / 需要＝人</span></footer></main>`;
  refreshStorageNotice();
  if (page === 0 || page === 2) {
    const c = classificationCounts(p, diaId);
    app
      .querySelector("main > header")
      ?.insertAdjacentHTML(
        "afterend",
        `<div class="classification-summary">選択ダイヤの全登録 ${c.registered}本 ／ 旅客が利用可能な営業 ${c.passenger}本 ／ 非営業 ${c.nonPassenger}本 ／ 要確認 ${c.review}本 ／ 運休 ${c.cancelled}本 <button data-page="8">分類を確認</button></div>`,
      );
  }
  if (p.oud2) {
    const route = app.querySelector(".route-art");
    route?.classList.add("station-list");
    route?.setAttribute("aria-label", "路線内の駅一覧（線形図ではありません）");
  }
}
app.addEventListener("click", (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>("button");
  if (!target) return;
  try {
    if (
      routeClick(target, uiContext()) ||
      temporalClick(target, uiContext()) ||
      classClick(target, uiContext()) ||
      assignmentClick(target, uiContext())
    )
      return;
    if (target.dataset.page !== undefined) {
      page = Number(target.dataset.page);
      render();
      return;
    }
    switch (target.dataset.action) {
      case "analyze":
        page = 2;
        break;
      case "dismiss":
        message = "";
        break;
      case "sample":
        replace(sampleProject());
        warnings = [];
        message = "架空鉄道サンプルを読み込みました";
        break;
      case "json":
        download(
          "railway-project.json",
          JSON.stringify(p, null, 2),
          "application/json",
        );
        return;
      case "workspaceJson":
        registerProject(p);
        validateWorkspace(workspace);
        download(
          "railway-workspace.json",
          JSON.stringify(workspace, null, 2),
          "application/json",
        );
        return;
      case "stationsCsv":
        download("stations.csv", stationCsv(p), "text/csv");
        return;
      case "odCsv":
        download("od-demand.csv", demandCsv(p), "text/csv");
        return;
      case "matrixCsv":
        download(
          "od-matrix.csv",
          csv([
            ["origin/destination", ...p.stations.map((s) => s.id)],
            ...p.stations.map((o) => [
              o.id,
              ...p.stations.map((d) =>
                p.demands
                  .filter((r) => r.origin === o.id && r.destination === d.id)
                  .reduce((a, r) => a + r.passengers, 0),
              ),
            ]),
          ]),
          "text/csv",
        );
        return;
      case "generate":
        p.demands = generateDemand(
          p,
          costMode === "manual" ? p.costs : timetableCosts(p, diaId),
        ).demands;
        save();
        page = 5;
        message = "推計ODを生成しました（既存ODを置換）";
        break;
    }
    render();
  } catch (e) {
    message = (e as Error).message;
    render();
  }
});
app.addEventListener("change", async (event) => {
  const el = event.target as HTMLInputElement;
  if (el.closest("#classification-page")) {
    classChange(el, uiContext());
    return;
  }
  if (el.closest("#assignment-page")) {
    assignmentChange(el, uiContext());
    return;
  }
  if (el.closest("#route-page")) {
    routeChange(el, uiContext());
    return;
  }
  if (el.closest("#temporal-page")) {
    temporalChange(el, uiContext());
    return;
  }
  const next = structuredClone(p);
  try {
    if (el.dataset.file) {
      const f = el.files?.[0];
      if (!f) return;
      if (f.size > 20 * 1024 * 1024)
        throw new Error("MVPの読み込み上限は20MBです");
      if (el.dataset.file === "oud2") {
        const bytes = new Uint8Array(await f.arrayBuffer());
        const decoded = decodeOud2(bytes, importEncoding);
        const result = parseOud2(decoded.text, {
          serviceDayStart:
            importDayStart === "file" ? "file" : Number(importDayStart),
        });
        result.project.oud2!.encoding = decoded.encoding;
        result.project.datasetId =
          "oud-" +
          Array.from(
            new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
            (b) => b.toString(16).padStart(2, "0"),
          ).join("");
        replace(result.project);
        warnings = result.warnings;
        message = `${f.name}: 基本データを取り込みました。警告・制限を確認してください`;
      } else {
        const text = await f.text();
        if (el.dataset.file === "json") {
          const value = JSON.parse(text);
          if (value.projects) {
            validateWorkspace(value);
            Object.assign(workspace, value);
            replace(
              value.projects.find(
                (x: Project) => x.datasetId === value.activeDatasetId,
              )!,
            );
          } else replace(value);
        }
        if (el.dataset.file === "stations") {
          const data = importStationCsv(p, text);
          data.demands = [];
          replace(data);
        }
        if (el.dataset.file === "od") replace(importDemandCsv(p, text));
        warnings = p.oud2?.warnings ?? [];
        message = `${f.name} を読み込みました`;
      }
      render();
      return;
    }
    if (
      el.type === "number" &&
      (!el.validity.valid || (el.value.trim() === "" && !el.dataset.costOrigin))
    )
      throw new Error("数値の範囲・空欄を確認してください");
    if (el.dataset.station) {
      const s = next.stations.find((s) => s.id === el.dataset.station)!;
      (s as unknown as Record<string, unknown>)[el.dataset.key!] = Number(
        el.value,
      );
      next.demands = [];
      validateProject(next);
      p = next;
      message = "都市データを更新しました。OD需要は再生成してください";
      save();
    } else if (el.dataset.costOrigin) {
      const o = el.dataset.costOrigin,
        d = el.dataset.costDestination!;
      next.costs[o] ??= {};
      if (el.value === "") delete next.costs[o][d];
      else next.costs[o][d] = Number(el.value);
      next.demands = [];
      validateProject(next);
      p = next;
      save();
    } else
      switch (el.id) {
        case "diaId":
          diaId = el.value;
          if (page === 6) refreshRoute(uiContext());
          break;
        case "origin":
          origin = el.value;
          break;
        case "destination":
          destination = el.value;
          break;
        case "direction":
          direction = el.value;
          break;
        case "typeId":
          typeId = el.value;
          break;
        case "start":
          if (Number(el.value) >= end)
            throw new Error("開始時刻は終了より前にしてください");
          start = Number(el.value);
          break;
        case "end":
          if (Number(el.value) <= start)
            throw new Error("終了時刻は開始より後にしてください");
          end = Number(el.value);
          break;
        case "costMode":
          costMode = el.value;
          break;
        case "encoding":
          importEncoding = el.value;
          return;
        case "importDayStart":
          importDayStart = el.value;
          return;
        default:
          if (Object.hasOwn(next.parameters, el.id)) {
            const key = el.id as keyof Parameters;
            (next.parameters as unknown as Record<string, unknown>)[key] =
              el.type === "number" ? Number(el.value) : el.value;
            validateProject(next);
            p = next;
            save();
          }
      }
    render();
  } catch (e) {
    message = (e as Error).message;
    render();
  }
});
void restore();
app.addEventListener("input", (event) => {
  const el = event.target as HTMLInputElement;
  if (el.closest("#route-page")) routeInput(el, uiContext());
});
app.addEventListener("keydown", (event) => {
  if (
    event.key === "Enter" &&
    (event.target as HTMLElement).closest("#route-page")
  ) {
    event.preventDefault();
    const b = document.querySelector<HTMLElement>(
      '[data-route-action="search"]',
    );
    if (b) {
      (event.target as HTMLInputElement).dispatchEvent(
        new Event("change", { bubbles: true }),
      );
      routeClick(b, uiContext());
    }
  }
});
