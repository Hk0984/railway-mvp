import type { DiagramTransfer } from "./assignment-model";
import type { DiagramSegment, DiagramTrain } from "./diagram-model";
import { escapeHtml as e, numberText as n } from "./ui-utils";

const people = (count: number) =>
  count > 0 && count < 0.1 ? "0.1人未満" : n(count) + "人";
const transferDirections = [
  ["fromConnection", "from", "接続列車から"],
  ["toConnection", "to", "接続列車へ"],
] as const;

export function trainChart(
  service: DiagramTrain,
  options: {
    station: (id: string) => string;
    origin: string;
    destination: string;
    peak?: DiagramSegment;
    crowdingFloor: number;
    transfers?: Record<number, DiagramTransfer>;
  },
) {
  const { station, origin, destination, peak, crowdingFloor, transfers } =
    options;
  const { segments, visits } = service;
  const visitIndex = new Map(visits.map((stop, i) => [stop, i]));
  const first = segments[0].from;
  const last = segments.at(-1)!.to;
  const firstVisit = visitIndex.get(first)!;
  const lastVisit = visitIndex.get(last)!;
  const connections = Object.entries(transfers ?? {}).flatMap(
    ([index, count]) => {
      const i = Number(index);
      return i >= firstVisit && i <= lastVisit
        ? [{ i, name: station(visits[i].stationId), count }]
        : [];
    },
  );
  const hasTransfers = connections.length > 0;
  const transferMessage =
    transfers === undefined
      ? '<p class="muted">接続列車との乗換客数 未算出</p>'
      : hasTransfers
        ? ""
        : '<p class="muted">計算対象の範囲に列車間の乗換はありません。</p>';
  if (!peak && !hasTransfers) return transferMessage;

  const start = firstVisit - Number(origin !== station(first.stationId));
  const end = lastVisit + Number(destination !== station(last.stationId));
  const stationLabels = new Map(connections.map(({ i, name }) => [i, name]));
  stationLabels.set(start, origin);
  stationLabels.set(end, destination);
  const labelLength = Math.max(
    ...Array.from(stationLabels.values(), (label) => Array.from(label).length),
  );

  const crowdingScale = Math.max(crowdingFloor, peak?.percent ?? 0);
  const transferScale = Math.ceil(
    Math.max(
      1,
      ...connections.flatMap(({ count }) => [
        count.fromConnection,
        count.toConnection,
      ]),
    ),
  );
  const left = Math.max(54, people(transferScale).length * 7 + 12);
  const right = 16;
  const edge = hasTransfers ? 10 : 0;
  const stationSpan = Math.max(1, end - start);
  const width = Math.max(
    310,
    left +
      right +
      edge * 2 +
      (hasTransfers ? 20 * stationSpan : 12 * labelLength * 2),
  );
  const stationX = (i: number) =>
    left +
    edge +
    ((i - start) / stationSpan) * (width - left - right - edge * 2);
  const runX = (s: DiagramSegment) =>
    (stationX(visitIndex.get(s.from)!) + stationX(visitIndex.get(s.to)!)) / 2;
  const crowdingTop = 26;
  const crowdingBase = 101;
  const transferTop = peak ? 138 : 26;
  const transferBase = transferTop + 69;
  const labelBase = hasTransfers ? transferBase : crowdingBase;
  const height = labelBase + (hasTransfers ? 18 + 12 * labelLength : 23);
  const axis = (
    label: string,
    top: number,
    base: number,
    high: string,
    zero: string,
  ) =>
    `<text x="3" y="${top - 11}" class="diagram-chart-heading">${label}</text>
    <path class="diagram-chart-axis" d="M${left} ${top}V${base}H${width - right}"/>
    <text x="${left - 6}" y="${top + 4}" text-anchor="end">${high}</text>
    <text x="${left - 6}" y="${base + 4}" text-anchor="end">${zero}</text>`;

  const runs = segments.filter((s) => s.kind === "run" || s.kind === "gap");
  const crowdingY = (value: number) =>
    crowdingBase - (value / crowdingScale) * (crowdingBase - crowdingTop);
  const crowding = peak
    ? axis("混雑率", crowdingTop, crowdingBase, n(crowdingScale) + "%", "0%") +
      runs
        .map((s, i) => {
          if (s.percent === null) return "";
          const x = runX(s),
            y = crowdingY(s.percent);
          const previous = runs[i - 1];
          const path =
            previous?.percent == null
              ? ""
              : `<path class="diagram-chart-line" d="M${runX(previous)} ${crowdingY(previous.percent)}L${x} ${y}"/>`;
          return (
            path +
            `<circle class="${s === peak ? "diagram-chart-peak" : "diagram-chart-point"}" cx="${x}" cy="${y}" r="${s === peak ? 5 : 3}"><title>${e(station(s.from.stationId))} → ${e(station(s.to.stationId))} ${n(s.percent)}%</title></circle>`
          );
        })
        .join("")
    : "";
  const bars = hasTransfers
    ? axis(
        "乗換客数（推計）",
        transferTop,
        transferBase,
        people(transferScale),
        "0人",
      ) +
      connections
        .map(({ i, name, count }) =>
          transferDirections
            .map(([key, style, label], side) => {
              if (count[key] === 0) return "";
              const size = Math.max(
                1,
                (count[key] / transferScale) * (transferBase - transferTop),
              );
              return `<rect class="diagram-transfer-${style}" x="${stationX(i) + (side ? 1 : -9)}" y="${transferBase - size}" width="8" height="${size}"><title>${e(name)} ${label} ${people(count[key])}</title></rect>`;
            })
            .join(""),
        )
        .join("")
    : "";
  const labels = Array.from(stationLabels)
    .sort(([a], [b]) => a - b)
    .map(([i, name]) => {
      const x = stationX(i);
      const placement = hasTransfers
        ? 'class="diagram-chart-station vertical"'
        : `class="diagram-chart-station" text-anchor="${i === start ? "start" : "end"}"`;
      return `<path class="diagram-chart-axis" d="M${x} ${labelBase}v4"/>
      <text ${placement} x="${x}" y="${labelBase + (hasTransfers ? 9 : 17)}">${e(name)}</text>`;
    })
    .join("");
  const legend = hasTransfers
    ? `<div class="diagram-transfer-legend">${transferDirections
        .map(
          ([, style, label]) =>
            `<span><i class="diagram-transfer-${style}" aria-hidden="true"></i>${label}</span>`,
        )
        .join("")}</div>`
    : "";
  const details = hasTransfers
    ? `<details class="diagram-transfer-values"><summary>駅別の乗換客数</summary>
        <table><thead><tr><th scope="col">駅</th>${transferDirections
          .map(([, , label]) => `<th scope="col">${label}</th>`)
          .join("")}</tr></thead>
        <tbody>${connections
          .map(
            ({ name, count }) =>
              `<tr><th scope="row">${e(name)}</th>${transferDirections
                .map(([key]) => `<td>${people(count[key])}</td>`)
                .join("")}</tr>`,
          )
          .join("")}</tbody></table></details>`
    : "";
  const description = [
    ...(peak ? ["駅間の混雑率。未算出区間は空白"] : []),
    ...(hasTransfers ? ["接続列車から・接続列車への推計乗換客数"] : []),
  ].join("。");
  return `<div class="diagram-train-chart" tabindex="0" role="region" aria-label="列車のグラフ">
      <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${description}">
        ${crowding}${bars}${labels}
      </svg>
    </div>${legend}${details}${transferMessage}`;
}
