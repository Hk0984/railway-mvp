export const tripPurposeLabels = {
  commute: "通勤",
  school: "通学",
  private: "非定期",
} as const;

export type TripPurpose = keyof typeof tripPurposeLabels;
export type PurposeShares = Record<TripPurpose, number>;

const residential = {
  shares: { commute: 55, school: 20, private: 25 },
  roles: { home: 5, commute: 1, school: 1, day: 1, night: 1 },
};

// Assumptions for fictional routes. Volume comes from the station counts.
const presets = {
  "low-density-residential": { label: "低密度住宅街", ...residential },
  "high-density-residential": { label: "高密度住宅街", ...residential },
  employment: {
    label: "事業所集積地",
    shares: { commute: 75, school: 5, private: 20 },
    roles: { home: 1, commute: 5, school: 1, day: 2, night: 1 },
  },
  education: {
    label: "学校・大学",
    shares: { commute: 15, school: 70, private: 15 },
    roles: { home: 1, commute: 1, school: 5, day: 1, night: 1 },
  },
  commercial: {
    label: "商業地",
    shares: { commute: 30, school: 5, private: 65 },
    roles: { home: 1, commute: 2, school: 1, day: 5, night: 1 },
  },
  nightlife: {
    label: "歓楽街",
    shares: { commute: 20, school: 5, private: 75 },
    roles: { home: 1, commute: 2, school: 1, day: 1, night: 5 },
  },
};

export type StationAttribute = keyof typeof presets;
export interface StationDemandProfile {
  primary?: StationAttribute;
  secondary?: StationAttribute;
  shares?: PurposeShares;
}

export const stationAttributes = Object.entries(presets).map(
  ([id, preset]) => ({
    id,
    name: preset.label,
  }),
);

export const tripPurposes = Object.keys(tripPurposeLabels) as TripPurpose[];
const standard = {
  shares: { commute: 40, school: 15, private: 45 },
  roles: { home: 1, commute: 1, school: 1, day: 1, night: 1 },
};
type Roles = typeof standard.roles;
const combine = (primary: number, secondary: number) =>
  primary * 0.75 + secondary * 0.25;

export function defaultPurposeShares(
  primary?: StationAttribute,
  secondary?: StationAttribute,
): PurposeShares {
  const shares = primary ? presets[primary].shares : standard.shares;
  if (!secondary) return shares;
  const other = presets[secondary].shares;
  return {
    commute: combine(shares.commute, other.commute),
    school: combine(shares.school, other.school),
    private: combine(shares.private, other.private),
  };
}

export function stationRoles({
  primary,
  secondary,
}: StationDemandProfile = {}): Roles {
  const roles = primary ? presets[primary].roles : standard.roles;
  if (!secondary) return roles;
  const other = presets[secondary].roles;
  return {
    home: combine(roles.home, other.home),
    commute: combine(roles.commute, other.commute),
    school: combine(roles.school, other.school),
    day: combine(roles.day, other.day),
    night: combine(roles.night, other.night),
  };
}

const validAttribute = (value: unknown): value is StationAttribute =>
  typeof value === "string" && Object.hasOwn(presets, value);

export function validateStationProfile(
  value: StationDemandProfile,
  name: string,
) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value.primary !== undefined && !validAttribute(value.primary)) ||
    (value.secondary !== undefined &&
      (!value.primary ||
        !validAttribute(value.secondary) ||
        value.secondary === value.primary))
  )
    throw new Error(`${name}の主属性・副属性を確認してください`);
  const shares = value.shares;
  if (shares === undefined) return;
  if (
    !shares ||
    typeof shares !== "object" ||
    Array.isArray(shares) ||
    tripPurposes.some(
      (purpose) =>
        !Number.isFinite(shares[purpose]) ||
        shares[purpose] < 0 ||
        shares[purpose] > 100,
    ) ||
    Math.abs(shares.commute + shares.school + shares.private - 100) > 1e-6
  )
    throw new Error(
      `${name}の通勤・通学・非定期の割合を合計100%にしてください`,
    );
}

function hours(...bands: [start: number, end: number, share: number][]) {
  const weights = Array<number>(24).fill(0);
  for (const [start, end, share] of bands)
    for (let i = start; i < end; i++)
      weights[i % 24] = share / (end - start) / 100;
  return weights;
}

const activityTiming = {
  commute: {
    outward: hours(
      [6, 7, 10],
      [7, 8, 32],
      [8, 9, 38],
      [9, 10, 15],
      [10, 12, 5],
    ),
    homeward: hours(
      [15, 17, 10],
      [17, 18, 20],
      [18, 19, 28],
      [19, 20, 22],
      [20, 22, 16],
      [22, 24, 4],
    ),
  },
  school: {
    outward: hours([6, 7, 6], [7, 8, 52], [8, 9, 36], [9, 11, 6]),
    homeward: hours([12, 14, 10], [14, 16, 40], [16, 18, 36], [18, 21, 14]),
  },
  day: {
    outward: hours([7, 10, 12], [10, 13, 38], [13, 16, 35], [16, 20, 15]),
    homeward: hours([10, 13, 12], [13, 16, 30], [16, 20, 48], [20, 23, 10]),
  },
  night: {
    outward: hours([15, 18, 12], [18, 20, 38], [20, 22, 35], [22, 25, 15]),
    homeward: hours(
      [18, 21, 10],
      [21, 23, 32],
      [23, 24, 28],
      [24, 25, 20],
      [25, 27, 10],
    ),
  },
};

export function purposeHours(
  origin: Roles,
  destination: Roles,
  purpose: TripPurpose,
) {
  const activities =
    purpose === "private" ? (["day", "night"] as const) : [purpose];
  const weights = Array<number>(24).fill(0);
  for (const activity of activities) {
    const { outward, homeward } = activityTiming[activity];
    const outwardAffinity = origin.home * destination[activity];
    const homewardAffinity = origin[activity] * destination.home;
    for (let hour = 0; hour < weights.length; hour++)
      weights[hour] +=
        outwardAffinity * outward[hour] + homewardAffinity * homeward[hour];
  }
  return weights;
}
