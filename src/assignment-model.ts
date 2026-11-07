import type { Purpose, Stop } from "./model";
import type { TimedOD } from "./temporal-model";
import type { Journey } from "./routing-model";
export interface ChoiceCoefficients {
  riding: number;
  waiting: number;
  walking: number;
  transferPenalty: number;
  scale: number;
}
export interface AssignmentConfig {
  method: "fastest" | "logit";
  start: number;
  end: number;
  maxTransfers: number;
  minimumTransferSeconds: number;
  maxWaitSeconds: number;
  maxJourneySeconds: number;
  maxChoices: number;
  integer: boolean;
  coefficients: Record<Purpose, ChoiceCoefficients>;
}
export interface AssignmentDemand extends TimedOD {
  datasetId: string;
}
export interface ArrivalCohort {
  id: string;
  demandIndex: number;
  start: number;
  end: number;
  arrival: number;
  passengers: number;
}
export interface PassengerAllocation {
  cohortId: string;
  journeyId: string;
  passengers: number;
  costMinutes: number;
  probability: number;
}
export interface UnallocatedDemand {
  cohortId: string;
  passengers: number;
  reason: string;
}
export interface TrainLoad {
  key: string;
  datasetId: string;
  timetableId: string;
  trainId: string;
  trainNumber: string;
  typeId: string;
  typeName: string;
  direction: "down" | "up";
  stops: Stop[];
  boardings: number[];
  alightings: number[];
  segmentLoads: number[];
  totalBoardings: number;
  totalAlightings: number;
  uniquePassengers: number;
  peakLoad: number;
  peakSegments: number[];
  capacity: number | null;
  capacitySource: "train" | "type" | "unknown";
  occupancies: (number | null)[];
  peakOccupancy: number | null;
}
export interface AssignmentResult {
  config: AssignmentConfig;
  input: AssignmentDemand[];
  cohorts: ArrivalCohort[];
  journeys: Record<string, Journey>;
  allocations: PassengerAllocation[];
  unallocated: UnallocatedDemand[];
  loads: TrainLoad[];
  totals: {
    input: number;
    selected: number;
    outsideWindow: number;
    assigned: number;
    unassigned: number;
    boardingEvents: number;
  };
  diagnostics: { profiles: number; milliseconds: number; warnings: string[] };
}
export function defaultAssignmentConfig(): AssignmentConfig {
  return {
    method: "fastest",
    start: 25200,
    end: 32400,
    maxTransfers: 1,
    minimumTransferSeconds: 120,
    maxWaitSeconds: 3600,
    maxJourneySeconds: 14400,
    maxChoices: 6,
    integer: false,
    coefficients: {
      commute: {
        riding: 1,
        waiting: 1.8,
        walking: 2,
        transferPenalty: 8,
        scale: 0.15,
      },
      school: {
        riding: 1,
        waiting: 1.4,
        walking: 1.8,
        transferPenalty: 6,
        scale: 0.12,
      },
      shopping: {
        riding: 1,
        waiting: 2,
        walking: 2,
        transferPenalty: 10,
        scale: 0.1,
      },
      private: {
        riding: 1,
        waiting: 1.8,
        walking: 2,
        transferPenalty: 8,
        scale: 0.1,
      },
    },
  };
}
export function validateAssignmentConfig(c: AssignmentConfig) {
  const nonnegative = (n: number) => Number.isFinite(n) && n >= 0;
  if (
    !c ||
    !["fastest", "logit"].includes(c.method) ||
    ![
      c.start,
      c.end,
      c.minimumTransferSeconds,
      c.maxWaitSeconds,
      c.maxJourneySeconds,
    ].every(nonnegative) ||
    c.end <= c.start ||
    c.maxJourneySeconds === 0 ||
    !Number.isInteger(c.maxTransfers) ||
    c.maxTransfers < 0 ||
    c.maxTransfers > 4 ||
    !Number.isInteger(c.maxChoices) ||
    c.maxChoices < 1 ||
    c.maxChoices > 30 ||
    typeof c.integer !== "boolean" ||
    !c.coefficients
  )
    throw new Error("旅客配分条件が不正です");
  for (const purpose of ["commute", "school", "shopping", "private"] as const) {
    const k = c.coefficients[purpose];
    if (
      !k ||
      ![k.riding, k.waiting, k.walking, k.transferPenalty, k.scale].every(
        nonnegative,
      )
    )
      throw new Error("目的別の経路選択係数は非負の有限数が必要です");
  }
}
