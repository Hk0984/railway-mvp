import { seatedCrowdingLimit } from "./diagram-model";
import { numberText as n } from "./ui-utils";

const marksAtCapacity = 40;
const displayLimit = 300;
const seatMarks = Math.round((seatedCrowdingLimit / 100) * marksAtCapacity);
const doorCenters = [97, 243, 397, 543];
const benches = [
  { x: 30, width: 34, seats: 1 },
  { x: 131, width: 77, seats: 2 },
  { x: 277, width: 86, seats: 2 },
  { x: 432, width: 77, seats: 2 },
  { x: 576, width: 34, seats: 1 },
];
const benchY = [31, 147];
const seatPositions = benches.flatMap(({ x, width, seats }) =>
  Array.from({ length: seats }, (_, i) =>
    benchY.map((y) => [x + ((i + 0.5) / seats) * width, y + 10]),
  ).flat(),
);

const aisleColumns = 22;
const aislePlaces = aisleColumns * 5;
const standPositions = Array.from({ length: aislePlaces }, (_, i) => {
  // Use a fixed order that spreads people along the carriage as density rises.
  const place = (i * 37) % aislePlaces;
  const row = Math.floor(place / aisleColumns);
  const column = place % aisleColumns;
  return [46 + 26 * column + (row % 2) * 5, 60 + 17 * row];
});

export function trainInterior(
  percent: number | null,
  passengers: number | null,
  carCount?: number,
) {
  if (percent === null || !Number.isFinite(percent) || percent < 0) return "";
  const count =
    percent === 0
      ? 0
      : Math.max(
          1,
          Math.round((Math.min(percent, displayLimit) * marksAtCapacity) / 100),
        );
  const seated = Math.min(seatMarks, count);
  const standing = count - seated;
  const marks = (positions: number[][], type: "seated" | "standing") =>
    `<g class="diagram-interior-${type}">${positions
      .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="6"/>`)
      .join("")}</g>`;
  return `<figure class="diagram-interior">
    <figcaption><strong>車内のイメージ</strong>${
      carCount && passengers !== null
        ? `<span class="muted">1両あたり平均 ${n(passengers / carCount)}人</span>`
        : ""
    }</figcaption>
    <svg viewBox="0 0 640 188" role="img" aria-label="混雑率${n(percent)}%。座席に${seated}点、通路に${standing}点を描いた車内の模式図">
      <rect class="diagram-interior-shell" x="12" y="15" width="616" height="158" rx="25"/>
      ${doorCenters
        .map((x) =>
          [15, 164]
            .map(
              (y) =>
                `<rect class="diagram-interior-door" x="${x - 20}" y="${y}" width="40" height="9" rx="2"/>
        <path class="diagram-interior-door" d="M${x} ${y}v9"/>`,
            )
            .join(""),
        )
        .join("")}
      ${benches
        .map(({ x, width }) =>
          benchY
            .map(
              (y) =>
                `<rect class="diagram-interior-seat" x="${x}" y="${y}" width="${width}" height="20" rx="5"/>`,
            )
            .join(""),
        )
        .join("")}
      ${marks(
        Array.from(
          { length: seated },
          (_, i) => seatPositions[(i * 5) % seatPositions.length],
        ),
        "seated",
      )}
      ${marks(standPositions.slice(0, standing), "standing")}
    </svg>
    <div class="diagram-interior-key" aria-hidden="true">
      <span class="diagram-interior-seated">着席</span>
      <span class="diagram-interior-standing">立席</span>
    </div>
    <p class="muted">輸送定員100%を${marksAtCapacity}点に換算した模式図です。座席は輸送定員の${seatedCrowdingLimit}%を想定しています。${
      percent > displayLimit
        ? `${displayLimit}%相当まで点で表示しています。`
        : ""
    }</p>
  </figure>`;
}
