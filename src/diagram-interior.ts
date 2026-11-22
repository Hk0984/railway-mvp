import { seatedCrowdingLimit } from "./diagram-model";
import { numberText as n } from "./ui-utils";

const sectionsPerCar = 4;
const maxVisiblePeople = 4096;
const doorPositions = [81, 359];
const doorRows = [13, 181];
const doorHeight = 10;
const benchY = [27, 159];

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

  const seats = Math.round(
    (capacity * seatedCrowdingLimit) / (100 * carCount * sectionsPerCar),
  );
  const seated = Math.min(seats, count);
  const standing = count - seated;
  const seatsPerSide = Math.ceil(seats / 2);
  const seatRadius = Math.min(6.5, 94 / seatsPerSide);
  const seatDots = Array.from({ length: seated }, (_, i) => {
    const side = i % 2;
    const rowSeats = Math.floor((seats + 1 - side) / 2);
    const rowPeople = Math.floor((seated + 1 - side) / 2);
    const slot = Math.floor(((Math.floor(i / 2) + 0.5) * rowSeats) / rowPeople);
    return dot(
      117 + ((slot + 0.5) * 206) / rowSeats,
      benchY[side] + 9,
      seatRadius,
    );
  }).join("");

  const columns = Math.max(20, Math.ceil(Math.sqrt(standing * 4)));
  // Leave a few open positions so the door clusters remain visible at high loads.
  const rows = Math.max(5, Math.ceil((standing * 1.2) / columns));
  const dx = 390 / columns;
  const dy = 105 / rows;
  const aisleRadius = Math.min(6.5, dx * 0.4, dy * 0.4);
  const aisleDots = Array.from({ length: columns * rows }, (_, i) => {
    const x = 25 + ((i % columns) + 0.5) * dx;
    const y = 49 + (Math.floor(i / columns) + 0.5) * dy;
    const horizontal = Math.min(
      ...doorPositions.map((doorX) => Math.abs(x - doorX)),
    );
    const vertical = Math.min(y - (doorRows[0] + doorHeight), doorRows[1] - y);
    return { x, y, doorDistance: Math.hypot(horizontal, vertical) };
  })
    .sort((a, b) => a.doorDistance - b.doorDistance)
    .slice(0, standing)
    .map(({ x, y }) => dot(x, y, aisleRadius))
    .join("");

  return `<figure class="diagram-interior">
    ${caption}
    <svg viewBox="0 0 440 204" role="img" aria-label="ドア2か所とその間の車内の模式図。推定${count}人、着席${seated}人、立席${standing}人">
      <rect class="diagram-interior-shell" x="12" y="13" width="416" height="178" rx="20"/>
      ${doorPositions
        .map((x) =>
          doorRows
            .map(
              (y) =>
                `<rect class="diagram-interior-door" x="${x - 24}" y="${y}" width="48" height="${doorHeight}" rx="2"/>
        <path class="diagram-interior-door" d="M${x} ${y}v${doorHeight}"/>`,
            )
            .join(""),
        )
        .join("")}
      ${benchY
        .map(
          (y) =>
            `<rect class="diagram-interior-seat" x="113" y="${y}" width="214" height="18" rx="5"/>`,
        )
        .join("")}
      <g class="diagram-interior-seated">${seatDots}</g>
      <g class="diagram-interior-standing">${aisleDots}</g>
    </svg>
    <div class="diagram-interior-key">
      <strong>1点＝1人</strong>
      <span class="diagram-interior-seated">着席</span>
      <span class="diagram-interior-standing">立席</span>
    </div>
    <p class="muted">ドア2か所とその間を1両の約4分の1として表示。乗客は各車両に均等に乗り、座席は輸送定員の${seatedCrowdingLimit}%と仮定しています。立席はドア前に集まりやすい配置で描いています。</p>
  </figure>`;
}
