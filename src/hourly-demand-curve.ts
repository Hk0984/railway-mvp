interface Transition {
  width: number;
  oneSided: boolean;
}

interface DemandEdge extends Transition {
  neighbor: number;
}

export interface HourlyDemandCurve {
  mean: number;
  rate: number;
  opening?: DemandEdge;
  closing?: DemandEdge;
}

const maxTransition = 0.4;

function transition(a: number, b: number): Transition {
  // A zero hour needs the entire ramp on the positive side of the boundary.
  if (a === 0 || b === 0) return { width: maxTransition, oneSided: true };
  const ratio = Math.min(a, b) / Math.max(a, b);
  return { width: maxTransition * Math.min(1, 2 * ratio), oneSided: false };
}

function neighborWeight({ width, oneSided }: Transition) {
  return width * (oneSided ? 0.5 : 3 / 16);
}

export function hourlyDemandCurve(
  shares: readonly number[],
  smooth: boolean,
): HourlyDemandCurve[] {
  if (!smooth) return shares.map((mean) => ({ mean, rate: mean }));
  const prior = (i: number) => (i + shares.length - 1) % shares.length;
  const next = (i: number) => (i + 1) % shares.length;
  const boundaries = shares.map((mean, i) => transition(mean, shares[next(i)]));
  const weights = boundaries.map(neighborWeight);

  // An hour's area is the weighted sum of its own rate and its neighbors'.
  // The narrow, ratio-limited ramps keep the rates positive and the system
  // diagonally dominant. Twenty-four iterations reach floating-point precision.
  let rates = shares;
  for (let iteration = 0; iteration < 24; iteration++) {
    rates = shares.map((mean, i) => {
      if (mean === 0) return 0;
      const left = weights[prior(i)];
      const right = weights[i];
      return (
        (mean - left * rates[prior(i)] - right * rates[next(i)]) /
        (1 - left - right)
      );
    });
  }

  return shares.map((mean, i) =>
    mean === 0
      ? { mean, rate: 0 }
      : {
          mean,
          rate: rates[i],
          opening: { ...boundaries[prior(i)], neighbor: rates[prior(i)] },
          closing: { ...boundaries[i], neighbor: rates[next(i)] },
        },
  );
}

function rateAtEdge(rate: number, edge: DemandEdge, distance: number) {
  const t = distance / edge.width;
  // For two positive hours these are the two halves of a single smoothstep.
  const weight = edge.oneSided
    ? 1 - t * t * (3 - 2 * t)
    : 0.5 - 0.75 * t + 0.25 * t ** 3;
  return rate * (1 - weight) + edge.neighbor * weight;
}

export function demandRate(
  { rate, opening, closing }: HourlyDemandCurve,
  t: number,
) {
  if (opening && t < opening.width) return rateAtEdge(rate, opening, t);
  if (closing && 1 - t < closing.width) return rateAtEdge(rate, closing, 1 - t);
  return rate;
}

// Integral of the neighbor's smoothstep weight from the boundary inward.
function edgeArea(edge: DemandEdge, distance: number) {
  if (edge.width === 0) return 0;
  const t = Math.min(1, distance / edge.width);
  return (
    edge.width *
    (edge.oneSided
      ? t - t ** 3 + 0.5 * t ** 4
      : 0.5 * t - 0.375 * t * t + 0.0625 * t ** 4)
  );
}

function accumulatedDemand(
  { mean, rate, opening, closing }: HourlyDemandCurve,
  t: number,
) {
  if (t <= 0) return 0;
  if (t >= 1) return mean;
  return (
    rate * t +
    (opening ? (opening.neighbor - rate) * edgeArea(opening, t) : 0) +
    (closing
      ? (closing.neighbor - rate) *
        (neighborWeight(closing) - edgeArea(closing, 1 - t))
      : 0)
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
