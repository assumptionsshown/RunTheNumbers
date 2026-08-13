// SVG chart primitives for episode slides. No dependencies: every chart is a
// string of SVG built here, so a viewer can read exactly how a picture was made.

const COLORS = {
  lumpsum: "#f0a35e",
  dca: "#4dc9c0",
  ink: "#f0f4f8",
  muted: "#8b98a5",
  rule: "#263140",
  warn: "#e5646e",
  ok: "#7bc86f",
};

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function scale(domain, range) {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  return (v) => r0 + ((v - d0) / span) * (r1 - r0);
}

function frame({ width, height, margin }) {
  return {
    width,
    height,
    margin,
    innerWidth: width - margin.left - margin.right,
    innerHeight: height - margin.top - margin.bottom,
  };
}

function svg(f, content) {
  return `<svg viewBox="0 0 ${f.width} ${f.height}" width="${f.width}" height="${f.height}" xmlns="http://www.w3.org/2000/svg" font-family="Segoe UI, system-ui, sans-serif">${content}</svg>`;
}

const text = (x, y, s, o = {}) =>
  `<text x="${x}" y="${y}" fill="${o.fill ?? COLORS.muted}" font-size="${o.size ?? 24}" font-weight="${o.weight ?? 400}" text-anchor="${o.anchor ?? "middle"}" dominant-baseline="${o.baseline ?? "auto"}" ${o.mono ? 'font-family="Cascadia Mono, Consolas, monospace"' : ""}>${esc(s)}</text>`;

const line = (x1, y1, x2, y2, o = {}) =>
  `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${o.stroke ?? COLORS.rule}" stroke-width="${o.width ?? 1}" ${o.dash ? `stroke-dasharray="${o.dash}"` : ""}/>`;

const rect = (x, y, w, h, o = {}) =>
  `<rect x="${x}" y="${y}" width="${Math.max(0, w)}" height="${Math.max(0, h)}" fill="${o.fill}" opacity="${o.opacity ?? 1}" rx="${o.rx ?? 0}"/>`;

/**
 * Distribution of the DCA-minus-lump-sum gap. Bars left of zero are start
 * months where the lump sum won.
 */
export function gapHistogram(bins, opts = {}) {
  const f = frame({ width: 1712, height: 560, margin: { top: 46, right: 40, bottom: 96, left: 80 } });
  const clipLow = opts.clipLow ?? -0.25;
  const clipHigh = opts.clipHigh ?? 0.35;

  const shown = bins.filter((b) => b.Low >= clipLow && b.Low < clipHigh);
  const overflow = bins.filter((b) => b.Low >= clipHigh).reduce((s, b) => s + b.Count, 0);

  const x = scale([clipLow, clipHigh], [f.margin.left, f.margin.left + f.innerWidth]);
  const maxCount = Math.max(...shown.map((b) => b.Count));
  const y = scale([0, maxCount], [f.margin.top + f.innerHeight, f.margin.top]);
  const baseY = f.margin.top + f.innerHeight;
  const binW = (shown[1]?.Low ?? 0.01) - (shown[0]?.Low ?? 0);

  let out = "";

  // Horizontal guides
  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const v = (maxCount / ticks) * i;
    out += line(f.margin.left, y(v), f.margin.left + f.innerWidth, y(v));
    out += text(f.margin.left - 18, y(v) + 8, Math.round(v), { anchor: "end", size: 22 });
  }

  for (const b of shown) {
    const isLumpSumWin = b.High <= 0;
    out += rect(x(b.Low) + 1, y(b.Count), Math.max(1, x(b.Low + binW) - x(b.Low) - 2), baseY - y(b.Count), {
      fill: isLumpSumWin ? COLORS.lumpsum : COLORS.dca,
      opacity: 0.92,
      rx: 2,
    });
  }

  // Zero line: the dividing line between the two answers.
  out += line(x(0), f.margin.top - 6, x(0), baseY + 12, { stroke: COLORS.ink, width: 3 });
  out += text(x(0), f.margin.top - 16, "same result", { fill: COLORS.ink, size: 24 });

  // X axis
  out += line(f.margin.left, baseY, f.margin.left + f.innerWidth, baseY, { stroke: COLORS.rule, width: 2 });
  for (let v = clipLow; v <= clipHigh + 1e-9; v += 0.05) {
    if (Math.abs(v) < 1e-9) v = 0;
    out += line(x(v), baseY, x(v), baseY + 10, { stroke: COLORS.rule, width: 2 });
    out += text(x(v), baseY + 42, `${v > 0 ? "+" : ""}${Math.round(v * 100)}%`, { size: 24 });
  }

  out += text(f.margin.left + f.innerWidth / 2, f.height - 16, opts.xLabel ?? "DCA result minus lump sum result", { size: 26 });

  if (overflow > 0) {
    out += text(
      f.margin.left + f.innerWidth - 10,
      f.margin.top + 40,
      `+${overflow} more start months beyond +${Math.round(clipHigh * 100)}%`,
      { anchor: "end", size: 24, fill: COLORS.dca },
    );
  }

  return svg(f, out);
}

/**
 * Horizontal bars. `labelWidth` reserves room on the left: a label longer than the
 * margin is silently clipped by the viewBox rather than overflowing visibly, which
 * turns "0.03%" into "3%" and is very easy to miss.
 */
export function horizontalBars(items, opts = {}) {
  const labelWidth = opts.labelWidth ?? 260;
  const height = opts.height ?? 480;
  const f = frame({
    width: 1712, height,
    margin: { top: 30, right: 260, bottom: opts.reference != null ? 66 : 40, left: labelWidth },
  });
  const max = opts.max ?? 1;
  const x = scale([0, max], [f.margin.left, f.margin.left + f.innerWidth]);
  const band = f.innerHeight / items.length;
  const labelSize = opts.labelSize ?? 34;

  let out = "";
  for (const [i, item] of items.entries()) {
    const yTop = f.margin.top + i * band + band * 0.18;
    const h = band * 0.64;
    out += rect(f.margin.left, yTop, f.innerWidth, h, { fill: COLORS.rule, opacity: 0.35, rx: 6 });
    out += rect(f.margin.left, yTop, x(item.value) - f.margin.left, h, {
      fill: item.color ?? COLORS.lumpsum,
      rx: 6,
    });
    out += text(f.margin.left - 28, yTop + h / 2 + labelSize * 0.35, item.label, {
      anchor: "end", size: labelSize, fill: COLORS.ink,
    });
    out += text(f.margin.left + f.innerWidth + 28, yTop + h / 2 + 13, item.display, {
      anchor: "start", size: 38, fill: item.color ?? COLORS.lumpsum, weight: 700,
    });
  }

  // A vertical line to compare every bar against, drawn last so it sits on top.
  if (opts.reference != null) {
    const rx = x(opts.reference);
    out += line(rx, f.margin.top - 8, rx, f.margin.top + f.innerHeight + 10, {
      stroke: COLORS.warn, width: 4, dash: "12 8",
    });
    out += text(rx, f.margin.top + f.innerHeight + 46, opts.referenceLabel ?? "", {
      size: 26, fill: COLORS.warn, weight: 600,
    });
  }

  return svg(f, out);
}

/**
 * Paired ranges: median and 5th percentile for both strategies at each horizon.
 * Makes the "premium vs payout" comparison visible in one picture.
 */
export function dumbbell(rows, opts = {}) {
  const f = frame({ width: 1712, height: 440, margin: { top: 40, right: 90, bottom: 74, left: 200 } });
  const values = rows.flatMap((r) => [r.lumpSum, r.dca]);
  const lo = Math.min(...values) * 0.96;
  const hi = Math.max(...values) * 1.04;
  const x = scale([lo, hi], [f.margin.left, f.margin.left + f.innerWidth]);
  const band = f.innerHeight / rows.length;

  let out = "";
  for (const [i, r] of rows.entries()) {
    const cy = f.margin.top + i * band + band / 2;
    out += line(f.margin.left, cy, f.margin.left + f.innerWidth, cy, { stroke: COLORS.rule, dash: "4 8" });
    out += line(x(r.lumpSum), cy, x(r.dca), cy, { stroke: COLORS.muted, width: 4 });
    out += `<circle cx="${x(r.lumpSum)}" cy="${cy}" r="16" fill="${COLORS.lumpsum}"/>`;
    out += `<circle cx="${x(r.dca)}" cy="${cy}" r="16" fill="${COLORS.dca}"/>`;
    out += text(f.margin.left - 34, cy + 12, r.label, { anchor: "end", size: 32, fill: COLORS.ink });

    const leftIsLs = r.lumpSum < r.dca;
    out += text(x(r.lumpSum) + (leftIsLs ? -28 : 28), cy + 11, r.lumpSum.toFixed(3), {
      anchor: leftIsLs ? "end" : "start", size: 27, fill: COLORS.lumpsum, mono: true,
    });
    out += text(x(r.dca) + (leftIsLs ? 28 : -28), cy + 11, r.dca.toFixed(3), {
      anchor: leftIsLs ? "start" : "end", size: 27, fill: COLORS.dca, mono: true,
    });
  }

  out += text(f.margin.left + f.innerWidth / 2, f.height - 22, opts.xLabel ?? "real value per $1 invested", { size: 26 });
  return svg(f, out);
}

/**
 * DCA's tail advantage as the holding period grows, with the region where
 * overlapping windows leave too little independent evidence shaded out.
 */
export function tailAdvantage(points, opts = {}) {
  const f = frame({ width: 1712, height: 520, margin: { top: 50, right: 60, bottom: 100, left: 130 } });
  const x = scale([0, points.length - 1], [f.margin.left, f.margin.left + f.innerWidth]);
  const maxAbs = Math.max(...points.map((p) => Math.abs(p.value))) * 1.25;
  const y = scale([-maxAbs, maxAbs], [f.margin.top + f.innerHeight, f.margin.top]);

  // Bars can be revealed a few at a time across consecutive slides. The axis is
  // always drawn in full so the chart reads as one picture being filled in
  // rather than as a different chart each time.
  const revealUpTo = opts.revealUpTo ?? points.length;

  let out = "";

  const noiseFrom = opts.showNoise === false
    ? -1
    : points.findIndex((p) => p.independentPeriods < (opts.minPeriods ?? 30));
  if (noiseFrom > 0) {
    out += rect(x(noiseFrom - 0.5), f.margin.top, f.margin.left + f.innerWidth - x(noiseFrom - 0.5), f.innerHeight, {
      fill: COLORS.warn, opacity: 0.07,
    });
    out += text(
      (x(noiseFrom - 0.5) + f.margin.left + f.innerWidth) / 2,
      f.margin.top + 34,
      opts.noiseLabel ?? "differences here are within noise",
      { size: 25, fill: COLORS.warn },
    );
  }

  out += line(f.margin.left, y(0), f.margin.left + f.innerWidth, y(0), { stroke: COLORS.ink, width: 2 });

  for (const [i, p] of points.entries()) {
    // Axis labels stay for every point; only the bars are held back.
    if (i < revealUpTo) {
      const h = Math.abs(y(p.value) - y(0));
      const top = p.value >= 0 ? y(p.value) : y(0);
      out += rect(x(i) - 26, top, 52, h, {
        fill: p.value >= 0 ? COLORS.dca : COLORS.lumpsum, rx: 4, opacity: 0.95,
      });
      out += text(x(i), p.value >= 0 ? y(p.value) - 16 : y(p.value) + 34, p.display, {
        size: 22, fill: p.value >= 0 ? COLORS.dca : COLORS.lumpsum, mono: true,
      });
    }
    out += text(x(i), f.margin.top + f.innerHeight + 44, p.label, {
      size: 26, fill: i < revealUpTo ? COLORS.muted : COLORS.rule,
    });
  }

  out += text(f.margin.left + f.innerWidth / 2, f.height - 20,
    opts.xLabel ?? "years held after the final purchase", { size: 26 });
  // Anchored to the left edge, not to the axis: right-aligning these against the
  // plot pushes them past x=0 and the first letter gets clipped by the viewBox.
  out += text(8, y(maxAbs * 0.75), opts.aboveLabel ?? "DCA better", { anchor: "start", size: 24, fill: COLORS.dca });
  out += text(8, y(-maxAbs * 0.75), opts.belowLabel ?? "DCA worse", { anchor: "start", size: 24, fill: COLORS.lumpsum });

  return svg(f, out);
}

/**
 * Several series over a shared x axis, labelled at the right-hand end rather than
 * in a legend, so the eye never has to travel to work out which line is which.
 *
 * series: [{ label, colour, points: [{x, y}], emphasis }]
 */
export function multiLine(series, opts = {}) {
  const f = frame({ width: 1712, height: 560, margin: { top: 40, right: 250, bottom: 96, left: 110 } });

  const xs = series.flatMap((s) => s.points.map((p) => p.x));
  const ys = series.flatMap((s) => s.points.map((p) => p.y));
  const x = scale([Math.min(...xs), Math.max(...xs)], [f.margin.left, f.margin.left + f.innerWidth]);
  const y = scale([opts.yMin ?? 0, opts.yMax ?? Math.max(...ys) * 1.1], [f.margin.top + f.innerHeight, f.margin.top]);

  let out = "";

  const ticks = opts.yTicks ?? 4;
  const yTop = opts.yMax ?? Math.max(...ys) * 1.1;
  for (let i = 0; i <= ticks; i++) {
    const v = (opts.yMin ?? 0) + ((yTop - (opts.yMin ?? 0)) / ticks) * i;
    out += line(f.margin.left, y(v), f.margin.left + f.innerWidth, y(v));
    out += text(f.margin.left - 20, y(v) + 8, opts.formatY ? opts.formatY(v) : v.toFixed(0), {
      anchor: "end", size: 22,
    });
  }

  for (const xt of opts.xTicks ?? []) {
    out += text(x(xt), f.margin.top + f.innerHeight + 44, String(xt), { size: 24 });
  }

  for (const s of series) {
    const width = s.emphasis ? 6 : 3;
    const opacity = s.emphasis ? 1 : 0.55;
    out += `<path d="${s.points.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.x)},${y(p.y)}`).join(" ")}" ` +
      `fill="none" stroke="${s.colour}" stroke-width="${width}" stroke-linejoin="round" opacity="${opacity}"/>`;

    const last = s.points[s.points.length - 1];
    out += text(x(last.x) + 18, y(last.y) + 8, s.label, {
      anchor: "start", size: s.emphasis ? 28 : 24, fill: s.colour,
      weight: s.emphasis ? 700 : 400,
    });
  }

  if (opts.xLabel) {
    out += text(f.margin.left + f.innerWidth / 2, f.height - 18, opts.xLabel, { size: 26 });
  }

  return svg(f, out);
}

/** Vertical bars with a reference line, used for the CAPE decile slide. */
export function verticalBars(items, opts = {}) {
  // With sublabels present, the old 520px frame put the axis caption's cap
  // height exactly on the sublabel baseline (y=476 on both), so long captions
  // visibly collided with the sublabel row (founder caught it on ep03 slide 7).
  // The taller frame moves only the caption; bar geometry is untouched because
  // innerHeight stays 350 either way.
  const hasSub = items.some((i) => i.sublabel);
  const marginLeft = opts.marginLeft ?? 110;
  const edgePadding = opts.edgePadding ?? 60;
  const f = frame({
    width: 1712,
    height: hasSub ? 560 : 520,
    margin: { top: 50, right: 50, bottom: hasSub ? 160 : 120, left: marginLeft },
  });
  const max = opts.max ?? Math.max(...items.map((i) => i.value)) * 1.3;
  const x = scale([0, items.length - 1], [f.margin.left + edgePadding, f.margin.left + f.innerWidth - edgePadding]);
  const y = scale([0, max], [f.margin.top + f.innerHeight, f.margin.top]);
  const bw = (f.innerWidth - edgePadding * 2) / items.length * 0.62;

  let out = "";
  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const v = (max / ticks) * i;
    out += line(f.margin.left, y(v), f.margin.left + f.innerWidth, y(v));
    out += text(f.margin.left - 20, y(v) + 8, `${Math.round(v * 100)}%`, { anchor: "end", size: 22 });
  }

  for (const [i, item] of items.entries()) {
    out += rect(x(i) - bw / 2, y(item.value), bw, y(0) - y(item.value), {
      fill: item.color ?? COLORS.dca, rx: 5, opacity: 0.92,
    });
    out += text(x(i), y(item.value) - 16, item.display, { size: 24, fill: COLORS.ink, mono: true });
    out += text(x(i), f.margin.top + f.innerHeight + 42, item.label, { size: 24 });
    if (item.sublabel) out += text(x(i), f.margin.top + f.innerHeight + 76, item.sublabel, { size: 21 });
  }

  if (opts.reference != null) {
    out += line(f.margin.left, y(opts.reference), f.margin.left + f.innerWidth, y(opts.reference), {
      stroke: COLORS.warn, width: 3, dash: "12 8",
    });
    // The reference label sits at the line's own height, which is exactly where
    // the value label of any bar level with the reference also sits. Anchoring
    // it left unconditionally put "everybody survives" on top of the first
    // bar's 100% in ep06. So pick the end whose bar is NOT level with the line;
    // if both are, drop to just under the line, where only bar fill can be.
    const level = (v) => Math.abs(y(v) - y(opts.reference)) < 44;
    const firstClear = !level(items[0].value);
    const lastClear = !level(items[items.length - 1].value);
    const above = firstClear || lastClear;
    out += text(
      firstClear ? f.margin.left + 8 : f.margin.left + f.innerWidth - 8,
      y(opts.reference) + (above ? -16 : 34),
      opts.referenceLabel ?? "",
      { anchor: firstClear ? "start" : "end", size: 24, fill: COLORS.warn },
    );
  }

  out += text(f.margin.left + f.innerWidth / 2, f.height - 18, opts.xLabel ?? "", { size: 26 });
  return svg(f, out);
}

export { COLORS };
