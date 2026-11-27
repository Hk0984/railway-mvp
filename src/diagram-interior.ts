import {
  bench,
  doorHeight,
  doorXs,
  doorYs,
  seatingPositions,
  standingPositions,
} from "./diagram-interior-layout";
import { seatedCrowdingLimit } from "./diagram-model";
import { numberText as n } from "./ui-utils";

const sectionsPerCar = 4;
const maxVisiblePeople = 4096;

const dot = (x: number, y: number, radius: number) =>
  `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${radius.toFixed(2)}"/>`;

export function trainInterior(
  passengers: number | null,
  capacity: number | null,
  carCount?: number,
) {
  if (passengers === null || capacity === null) return "";
  if (!carCount)
    return `<p class="muted">車内図を表示するには、<a href="#settings">データ設定</a>で編成両数を登録してください。</p>`;

  const average = passengers / carCount;
  const count = Math.round(average / sectionsPerCar);
  const caption = `<figcaption><strong>車内のイメージ</strong><span>この範囲の推定 ${n(count, 0)}人</span><span class="muted">1両あたり平均 ${n(average)}人</span></figcaption>`;
  if (count > maxVisiblePeople)
    return `<figure class="diagram-interior">${caption}<p class="muted">点が判別できる密度を超えているため、人数のみ表示しています。</p></figure>`;

  const seats = Math.min(
    maxVisiblePeople,
    Math.round(
      (capacity * seatedCrowdingLimit) / (100 * carCount * sectionsPerCar),
    ),
  );
  const seated = Math.min(seats, count);
  const standing = count - seated;
  const inSeats = seatingPositions(seats, seated);
  const inAisle = standingPositions(standing);

  return `<figure class="diagram-interior">
    ${caption}
    <svg viewBox="0 0 440 204" role="img" aria-label="ドア2か所とその間の車内の模式図。推定${count}人、着席${seated}人、立席${standing}人">
      <rect class="diagram-interior-shell" x="12" y="13" width="416" height="178" rx="20"/>
      ${doorXs
        .map((x) =>
          doorYs
            .map(
              (y) =>
                `<rect class="diagram-interior-door" x="${x - 24}" y="${y}" width="48" height="${doorHeight}" rx="2"/>
        <path class="diagram-interior-door" d="M${x} ${y}v${doorHeight}"/>`,
            )
            .join(""),
        )
        .join("")}
      ${bench.rows
        .map(
          (y) =>
            `<rect class="diagram-interior-seat" x="${bench.x}" y="${y}" width="${bench.width}" height="${bench.height}" rx="5"/>`,
        )
        .join("")}
      <g class="diagram-interior-seated">${inSeats.people.map(({ x, y }) => dot(x, y, inSeats.radius)).join("")}</g>
      <g class="diagram-interior-standing">${inAisle.people.map(({ x, y }) => dot(x, y, inAisle.radius)).join("")}</g>
    </svg>
    <div class="diagram-interior-key">
      <strong>1点＝1人</strong>
      <span class="diagram-interior-seated">着席</span>
      <span class="diagram-interior-standing">立席</span>
    </div>
    <p class="muted">車両ごとの人数は均等、図は1両の約4分の1、座席数は輸送定員の${seatedCrowdingLimit}%と仮定しています。長い座席の端やドア付近を好み、空いているときは周囲の人と間隔を取る様子を模式化しています。</p>
  </figure>`;
}
