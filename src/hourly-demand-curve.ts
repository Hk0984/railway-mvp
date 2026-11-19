export interface HourlyDemandCurve {
  mean: number;
  left: number;
  right: number;
}

export function hourlyDemandCurve(
  shares: readonly number[],
  smooth: boolean,
): HourlyDemandCurve[] {
  return shares.map((mean, i) =>
    smooth
      ? {
          mean,
          left: Math.min(mean, shares[(i + shares.length - 1) % shares.length]),
          right: Math.min(mean, shares[(i + 1) % shares.length]),
        }
      : { mean, left: mean, right: mean },
  );
}

// Join neighboring hours at a shared rate. The added bump has unit area,
// vanishes at both endpoints, and restores the exact total for this hour.
export function demandRate(
  { mean, left, right }: HourlyDemandCurve,
  t: number,
) {
  const excess = mean - (left + right) / 2;
  return (
    left +
    (right - left) * t * t * (3 - 2 * t) +
    excess * 30 * (t * (1 - t)) ** 2
  );
}

function accumulatedDemand(
  { mean, left, right }: HourlyDemandCurve,
  t: number,
) {
  if (t <= 0) return 0;
  if (t >= 1) return mean;
  const excess = mean - (left + right) / 2;
  return (
    left * t +
    (right - left) * t ** 3 * (1 - t / 2) +
    excess * t ** 3 * (10 - 15 * t + 6 * t * t)
  );
}

/** Integrate part of one clock hour. The right endpoint can be exactly on the next hour. */
export function demandMass(
  curve: HourlyDemandCurve,
  start: number,
  end: number,
) {
  const base = Math.floor(start / 3600) * 3600;
  return Math.max(
    0,
    accumulatedDemand(curve, (end - base) / 3600) -
      accumulatedDemand(curve, (start - base) / 3600),
  );
}
