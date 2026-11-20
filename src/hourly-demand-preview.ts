import { clock } from "./analysis";
import { demandRate, hourlyDemandCurve } from "./hourly-demand-curve";

export const demandCurveColors = { up: "#006751", down: "#783e81" };

export function drawHourlyDemand(
  canvas: HTMLCanvasElement,
  shares: { up: number[]; down: number[] },
  firstHour: number,
  smooth: boolean,
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const hours = shares.up.length;
  const colors = Object.values(demandCurveColors);
  const series = [shares.up, shares.down].map((values) => {
    const curves = hourlyDemandCurve(values, smooth);
    return Array.from({ length: hours }, (_, i) =>
      Array.from({ length: 13 }, (_, step) => {
        const t = step / 12;
        return {
          hour: i + t,
          rate: demandRate(curves[(firstHour + i) % hours], t),
        };
      }),
    ).flat();
  });
  const max = Math.max(1, ...series.flat().map(({ rate }) => rate));
  const top = 12;
  const bottom = canvas.height - 24;
  const left = 38;
  const right = canvas.width - 23;
  const x = (hour: number) => left + (hour / hours) * (right - left);
  const y = (rate: number) => bottom - (rate / max) * (bottom - top);

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.font = "14px sans-serif";
  ctx.fillStyle = "#435769";
  ctx.strokeStyle = "#dee7ed";
  ctx.lineWidth = 1;
  ctx.textAlign = "right";
  for (const rate of [0, max / 2, max]) {
    const position = y(rate);
    ctx.beginPath();
    ctx.moveTo(left, position);
    ctx.lineTo(right, position);
    ctx.stroke();
    ctx.fillText(String(Number(rate.toFixed(1))), left - 5, position + 4);
  }
  ctx.textAlign = "center";
  for (let i = 0; i <= hours; i += 4)
    ctx.fillText(clock((firstHour + i) * 3600), x(i), bottom + 19);
  ctx.lineWidth = 2.6;
  for (const [i, values] of series.entries()) {
    ctx.strokeStyle = colors[i];
    ctx.setLineDash(i === 1 ? [7, 4] : []);
    ctx.beginPath();
    for (const [j, point] of values.entries()) {
      if (j === 0) ctx.moveTo(x(point.hour), y(point.rate));
      else ctx.lineTo(x(point.hour), y(point.rate));
    }
    ctx.stroke();
  }
  ctx.setLineDash([]);
}
