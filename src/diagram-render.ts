import { clock } from "./analysis";
import { crowdingBand, type DiagramSegment } from "./diagram-model";

export const plotLeft = 115;
export const plotTop = 29;
export const rowHeight = 30;
const hour = 3600;
const typeColors = [
  "#244b58",
  "#285fa2",
  "#91452e",
  "#64517c",
  "#406336",
  "#8a3e65",
];

export interface PlotLine {
  segment: DiagramSegment;
  y1: number;
  y2: number;
  type: number;
}
export interface VisibleLine extends PlotLine {
  x1: number;
  x2: number;
}
export interface PlotView {
  width: number;
  height: number;
  left: number;
  top: number;
  start: number;
  pixelsPerHour: number;
}
export interface DiagramRenderSettings {
  lineWidth: number;
  enabled: boolean;
  selectedOnly: boolean;
  width: number;
  opacity: number;
  limits: number[];
  colors: string[];
}

export function indexPlot(lines: PlotLine[]) {
  const buckets = new Map<number, PlotLine[]>();
  const longLines: PlotLine[] = [];
  for (const line of lines) {
    const first = Math.floor(line.segment.start / hour);
    const last = Math.floor(line.segment.end / hour);
    if (last - first > 4) {
      longLines.push(line);
      continue;
    }
    for (let i = first; i <= last; i++) {
      const bucket = buckets.get(i);
      if (bucket) bucket.push(line);
      else buckets.set(i, [line]);
    }
  }
  return (start: number, end: number) => {
    const visible = new Set(longLines);
    for (let i = Math.floor(start / hour); i <= Math.floor(end / hour); i++)
      for (const line of buckets.get(i) ?? []) visible.add(line);
    return visible;
  };
}

function strokeLine(path: Path2D, line: VisibleLine, top: number) {
  path.moveTo(line.x1, line.y1 - top);
  path.lineTo(
    line.x2 === line.x1 && line.y1 === line.y2 ? line.x2 + 0.5 : line.x2,
    line.y2 - top,
  );
}

const hazeCache = new WeakMap<
  CanvasRenderingContext2D,
  { key: string; hasHaze: boolean }
>();

export function drawDiagram(
  ctx: CanvasRenderingContext2D,
  haze: CanvasRenderingContext2D,
  view: PlotView,
  stationNames: string[],
  candidates: Iterable<PlotLine>,
  settings: DiagramRenderSettings,
  selected: string,
  selectedSegment?: DiagramSegment,
) {
  const { width, height, top, left, start, pixelsPerHour } = view;
  const x = (time: number) =>
    plotLeft + ((time - start) / hour) * pixelsPerHour - left;
  const visible: VisibleLine[] = [];
  const margin = settings.enabled ? settings.width : 4;
  const tracks = typeColors.map(() => new Path2D());
  const hazeKey =
    settings.enabled && (!settings.selectedOnly || selected)
      ? JSON.stringify([
          view,
          haze.canvas.width,
          haze.canvas.height,
          settings.width,
          settings.colors,
          settings.limits,
          settings.selectedOnly ? selected : "",
        ])
      : "";
  const cached = hazeKey ? hazeCache.get(haze) : undefined;
  const reuseHaze = cached?.key === hazeKey;
  const bands =
    hazeKey && !reuseHaze ? settings.colors.map(() => new Path2D()) : [];
  const gaps = new Path2D();
  const highlight = new Path2D();
  const highlightGaps = new Path2D();
  const focus = new Path2D();
  let hazeSegments = 0;
  for (const line of candidates) {
    const x1 = x(line.segment.start),
      x2 = x(line.segment.end);
    if (
      x2 < plotLeft - margin ||
      x1 > width + margin ||
      Math.max(line.y1, line.y2) - top < plotTop - margin ||
      Math.min(line.y1, line.y2) - top > height + margin
    )
      continue;
    const positioned = { ...line, x1, x2 };
    visible.push(positioned);
    const gap = line.segment.kind === "gap";
    strokeLine(gap ? gaps : tracks[line.type % tracks.length], positioned, top);
    const active = line.segment.service.train.id === selected;
    if (active) strokeLine(gap ? highlightGaps : highlight, positioned, top);
    if (line.segment === selectedSegment && !gap)
      strokeLine(focus, positioned, top);
    if (bands.length && (!settings.selectedOnly || active)) {
      const band = crowdingBand(line.segment.percent, settings.limits);
      if (band >= 0) {
        strokeLine(bands[band], positioned, top);
        hazeSegments++;
      }
    }
  }

  ctx.clearRect(0, 0, width, height);
  ctx.save();
  ctx.beginPath();
  ctx.rect(
    plotLeft,
    plotTop,
    Math.max(0, width - plotLeft),
    Math.max(0, height - plotTop),
  );
  ctx.clip();
  const tick = pixelsPerHour >= 220 ? 600 : pixelsPerHour >= 110 ? 900 : 1800;
  const firstTick =
    Math.ceil((start + (left * hour) / pixelsPerHour) / tick) * tick;
  ctx.lineWidth = 1;
  for (let time = firstTick; x(time) <= width; time += tick) {
    ctx.strokeStyle = time % hour === 0 ? "#a8bcb4" : "#e2ebe6";
    ctx.beginPath();
    ctx.moveTo(x(time), plotTop);
    ctx.lineTo(x(time), height);
    ctx.stroke();
  }
  const firstRow = Math.max(0, Math.floor(top / rowHeight));
  const lastRow = Math.min(
    stationNames.length,
    firstRow + Math.ceil(height / rowHeight) + 1,
  );
  ctx.strokeStyle = "#dce7e1";
  ctx.beginPath();
  for (let i = firstRow; i < lastRow; i++) {
    const y = plotTop + (i + 1) * rowHeight - top;
    ctx.moveTo(plotLeft, y);
    ctx.lineTo(width, y);
  }
  ctx.stroke();

  const hasHaze = hazeSegments > 0;
  if (hasHaze) {
    haze.clearRect(0, 0, width, height);
    haze.lineCap = "round";
    // Gaussian-like falloff with batched paths. The composite opacity caps dense overlaps.
    const layers = hazeSegments > 500 ? [8, 6, 4, 2] : [8, 7, 6, 5, 4, 3, 2, 1];
    for (const layer of layers) {
      haze.lineWidth = (settings.width * layer) / 4;
      haze.globalAlpha = (9 - layer) * (layers.length === 4 ? 0.085 : 0.047);
      bands.forEach((path, band) => {
        haze.strokeStyle = settings.colors[band];
        haze.stroke(path);
      });
    }
  }
  if (hazeKey && !reuseHaze) hazeCache.set(haze, { key: hazeKey, hasHaze });
  if (hasHaze || (reuseHaze && cached?.hasHaze)) {
    ctx.globalAlpha = settings.opacity;
    ctx.drawImage(haze.canvas, 0, 0, width, height);
    ctx.globalAlpha = 1;
  }

  ctx.lineCap = "round";
  ctx.lineWidth = settings.lineWidth;
  tracks.forEach((path, i) => {
    ctx.strokeStyle = typeColors[i];
    ctx.stroke(path);
  });
  ctx.setLineDash([3, 4]);
  ctx.strokeStyle = "#667a80";
  ctx.stroke(gaps);
  ctx.setLineDash([]);
  if (selected) {
    const line = visible.find((v) => v.segment.service.train.id === selected);
    if (line) {
      ctx.strokeStyle = typeColors[line.type % typeColors.length];
      ctx.lineWidth = settings.lineWidth + 1.4;
      ctx.stroke(highlight);
      ctx.setLineDash([3, 4]);
      ctx.stroke(highlightGaps);
      ctx.setLineDash([]);
      ctx.lineWidth = settings.lineWidth + 2.8;
      ctx.stroke(focus);
      ctx.font = "bold 12px sans-serif";
      ctx.fillStyle = ctx.strokeStyle;
      const t = line.segment.service.train;
      const labelX = Math.max(plotLeft + 4, Math.min(width - 55, line.x1 + 4));
      const labelY = Math.max(plotTop + 13, line.y1 - top - 5);
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 3;
      ctx.strokeText(t.number || t.id, labelX, labelY);
      ctx.fillText(t.number || t.id, labelX, labelY);
    }
  }
  ctx.restore();

  ctx.fillStyle = "#f5f8f7";
  ctx.fillRect(0, 0, width, plotTop);
  ctx.fillRect(0, plotTop, plotLeft, height - plotTop);
  ctx.fillStyle = "#324b42";
  ctx.font = "12px sans-serif";
  ctx.save();
  ctx.beginPath();
  ctx.rect(plotLeft, 0, Math.max(0, width - plotLeft), plotTop);
  ctx.clip();
  for (let time = firstTick; x(time) <= width; time += tick)
    ctx.fillText(clock(time), x(time) + 3, 19);
  ctx.restore();
  ctx.fillText("駅 ／ 時刻", 8, 19);
  for (let i = firstRow; i < lastRow; i++) {
    const y = plotTop + (i + 1) * rowHeight - top;
    if (y > plotTop + 8) ctx.fillText(stationNames[i], 8, y + 4, plotLeft - 14);
  }
  return visible;
}

export function hitLine(
  lines: VisibleLine[],
  x: number,
  y: number,
  top: number,
  selected: string,
) {
  let best: DiagramSegment | undefined;
  let nearest = 7 ** 2;
  for (const line of lines) {
    const dx = line.x2 - line.x1,
      dy = line.y2 - line.y1;
    const px = x - line.x1,
      py = y + top - line.y1;
    const t = Math.max(
      0,
      Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy || 1)),
    );
    const distance = (px - dx * t) ** 2 + (py - dy * t) ** 2;
    if (
      distance < nearest ||
      (distance === nearest && line.segment.service.train.id === selected)
    ) {
      best = line.segment;
      nearest = distance;
    }
  }
  return best;
}
