export const doorXs = [81, 359];
export const doorYs = [13, 181];
export const doorHeight = 10;
export const bench = { x: 113, width: 214, height: 18, rows: [27, 159] };

interface Position {
  x: number;
  y: number;
}

interface Candidate extends Position {
  preference: number;
}

// Repeatable variation breaks ties and loosens standing rows between redraws.
function variation(index: number) {
  const value = Math.sin(index * 12.9898 + 78.233) * 43758.5453;
  return value - Math.floor(value);
}

function choosePositions(
  candidates: Candidate[],
  count: number,
  spacing: number,
) {
  const preferredDistance = spacing * spacing;
  const crowding = new Float64Array(candidates.length);
  const chosen: Position[] = [];
  while (chosen.length < count) {
    const last = chosen.at(-1);
    let best = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < candidates.length; i++) {
      if (crowding[i] < 0) continue;
      const point = candidates[i];
      if (last) {
        const dx = point.x - last.x;
        const dy = point.y - last.y;
        // Nearby riders each lower the score, including on both sides of a seat.
        crowding[i] += Math.max(0, 1 - (dx * dx + dy * dy) / preferredDistance);
      }
      const score = point.preference - crowding[i];
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    crowding[best] = -1;
    chosen.push(candidates[best]);
  }
  return chosen;
}

export function seatingPositions(seats: number, seated: number) {
  const pitch = bench.width / Math.ceil(seats / bench.rows.length);
  const candidates = bench.rows.flatMap((y, row) => {
    const rowSeats = Math.floor((seats + 1 - row) / bench.rows.length);
    return Array.from({ length: rowSeats }, (_, slot) => {
      const endSeat = slot === 0 || slot === rowSeats - 1;
      return {
        x: bench.x + ((slot + 0.5) * bench.width) / rowSeats,
        y: y + bench.height / 2,
        preference: (endSeat ? 0.32 : 0) + 0.1 * variation(slot * 2 + row),
      };
    });
  });
  return {
    people: choosePositions(candidates, seated, Math.min(145, pitch * 2.2)),
    radius: Math.min(6.5, pitch * 0.44),
  };
}

export function standingPositions(count: number) {
  if (count === 0) return { people: [], radius: 0 };
  const room = Math.ceil(count * 1.18);
  const columns = Math.max(22, Math.ceil(Math.sqrt(room * 3.7)));
  const rows = Math.max(6, Math.ceil(room / columns));
  const dx = 390 / columns;
  const dy = 105 / rows;
  const jitter = 0.17;
  const candidates = Array.from({ length: columns * rows }, (_, i) => {
    const x =
      25 + ((i % columns) + 0.5 + jitter * (2 * variation(i * 3) - 1)) * dx;
    const y =
      49 +
      (Math.floor(i / columns) +
        0.5 +
        jitter * (2 * variation(i * 3 + 1) - 1)) *
        dy;
    const horizontal = Math.min(...doorXs.map((doorX) => Math.abs(x - doorX)));
    const vertical = Math.min(y - (doorYs[0] + doorHeight), doorYs[1] - y);
    const distance = Math.hypot(horizontal, vertical);
    const nearDoor = Math.max(0, 1 - distance / 165);
    return { x, y, preference: nearDoor * 0.9 + 0.13 * variation(i * 3 + 2) };
  });
  return {
    people: choosePositions(candidates, count, 31),
    // Even adjacent jittered positions leave clearance between their markers.
    radius: Math.min(6.5, Math.min(dx, dy) * (0.5 - jitter)),
  };
}
