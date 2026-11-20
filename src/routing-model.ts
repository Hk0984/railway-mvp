import type { Project, Stop } from "./model";
export interface StationRef {
  datasetId: string;
  stationId: string;
}
export const stationKey = (ref: StationRef) =>
  JSON.stringify([ref.datasetId, ref.stationId]);
export interface TransferLink {
  enabled?: boolean;
  additionalTransferSeconds?: number;
  restrictions?: string[];
  id: string;
  from: StationRef;
  to: StationRef;
  walkingSeconds: number;
  direction: "forward" | "both";
  basis: string;
}
export interface DatasetSelection {
  datasetId: string;
  project: Project;
  timetableId: string;
  allowedTypeIds?: string[];
  /** False is reserved for all-train analysis and historical regression, never passenger assignment. */
  passengerOnly?: boolean;
}
export interface RouteQuery {
  /** Internal candidate storage. Expand selected journeys before display or validation. */
  compactProfile?: boolean;
  /** Train IDs that cross the line boundary on the first or last leg. */
  boundaryOriginTrains?: string[];
  boundaryDestinationTrains?: string[];
  origin: StationRef;
  destination: StationRef;
  mode: "depart" | "arrive";
  time: number;
  maxTransfers: number;
  minimumTransferSeconds: number;
  directOnly: boolean;
  sort: "arrival" | "transfers" | "riding";
  limit?: number;
  windowStart?: number;
  windowEnd?: number;
  /** Keep departure/wait alternatives for explicit passenger-choice modelling. */
  candidateMode?: "earliest" | "choices";
}
export interface JourneyLeg {
  datasetId: string;
  timetableId: string;
  trainId: string;
  trainNumber: string;
  typeId: string;
  typeName: string;
  origin: StationRef;
  destination: StationRef;
  departure: number;
  arrival: number;
  boardIndex: number;
  alightIndex: number;
  stops: Stop[];
}
export interface JourneyTransfer {
  from: StationRef;
  to: StationRef;
  arrival: number;
  departure: number;
  walkingSeconds: number;
  waitingSeconds: number;
  minimumSeconds: number;
  linkIds: string[];
}
export interface Journey {
  id: string;
  departure: number;
  arrival: number;
  elapsedSeconds: number;
  ridingSeconds: number;
  transferWaitSeconds: number;
  walkingSeconds: number;
  transferCount: number;
  legs: JourneyLeg[];
  transfers: JourneyTransfer[];
  valid: boolean;
}
export interface RouteSearchResult {
  journeys: Journey[];
  candidateCount: number;
  warnings: string[];
  reason?: string;
  displayLimited: boolean;
}
