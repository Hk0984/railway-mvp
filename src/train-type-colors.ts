import type { TrainType } from "./model";

const fallbackColors = [
  "#244b58",
  "#285fa2",
  "#91452e",
  "#64517c",
  "#406336",
  "#8a3e65",
];

export const defaultTrainTypeColor = fallbackColors[0];

export function trainTypeColors(types: TrainType[]) {
  return new Map(
    types.map(({ id, timetableColor, diagramColor }, i) => {
      const fallback = fallbackColors[i % fallbackColors.length];
      return [
        id,
        {
          diagram: diagramColor ?? timetableColor ?? fallback,
          timetable: timetableColor ?? diagramColor ?? fallback,
        },
      ];
    }),
  );
}
