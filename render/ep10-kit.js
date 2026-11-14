// ep10 "The Nguyens: Social Security at 62 or 70?" (2026-11-13): shared ledger + hand-drawn kit
// for render/ep10-nguyens.html (16:9), ep10-vertical.html and ep10-short.html (9:16), and the
// thumbnails. The ledger here is computed from the pinned SSA + Shiller snapshots at load; the
// spoken numbers are checked independently by tools/validate-ep10-story.mjs (which does not
// import this file). Conventions are the validator's: month k = k months after the 62nd
// birthday; today's money; Minh's way invests the $1,400 checks for months 0..95, then pays a
// $1,080 top-up each month from the pile until it cannot.
const parse = (t) => { const [h, ...rows] = t.trim().split(/\r?\n/); const c = h.split(","); return rows.map((r) => Object.fromEntries(r.split(",").map((v, i) => [c[i], v]))); };

export async function loadModel(base = "..") {
  const [shCsv, lifeCsv, rules] = await Promise.all([
    fetch(`${base}/data/snapshots/shiller-2026-07-26/shiller-monthly.csv`).then((r) => r.text()).then(parse),
    fetch(`${base}/data/snapshots/ssa-2026-11-13/period-life-table-2023.csv`).then((r) => r.text()).then(parse),
    fetch(`${base}/data/snapshots/ssa-2026-11-13/claiming-rules.json`).then((r) => r.json()),
  ]);
  const SH = shCsv.filter((r) => r.cpi !== "" && Number.isFinite(+r.cpi) && r.price !== "").map((r) => ({ m: r.date, real: +r.realTotalReturnPrice }));
  const AT = new Map(SH.map((r, i) => [r.m, i])), LAST = SH.length - 1;
  const PIA = 2000, pct = (a) => rules.percentOfPIA[String(a)];
  const EARLY = PIA * pct(62) / 100, FRA = PIA * pct(67) / 100, LATE = PIA * pct(70) / 100, TOP = LATE - EARLY;
  const early = (m) => EARLY * m, late = (m) => LATE * Math.max(0, m - 96);
  let BE = 97; while (late(BE) < early(BE)) BE++;
  const LIFE = lifeCsv.map((r) => ({ m: +r.male_lx, f: +r.female_lx, me: +r.male_ex, fe: +r.female_ex }));
  const lx = (s, a) => { const lo = Math.floor(a), f = a - lo; const v = (x) => LIFE[Math.min(119, x)][s]; return v(lo) * (1 - f) + v(lo + 1) * f; };
  const surv = (s, a) => lx(s, a) / lx(s, 62);
  const lifetime = (s, c) => { const b = PIA * pct(c) / 100; let x = 0; for (let k = (c - 62) * 12; k < 57 * 12; k++) x += b * surv(s, 62 + k / 12); return x; };
  function minhWay(i0, months) {
    const pile = []; let p = 0, runout = null, atSeventy = 0;
    for (let k = 0; k <= months; k++) {
      if (k > 0) p *= SH[i0 + k].real / SH[i0 + k - 1].real;
      if (k === 96) atSeventy = p;
      if (k < 96) p += EARLY; else if (p >= TOP) p -= TOP; else { if (runout == null) runout = k; p = 0; }
      pile.push(p);
    }
    return { m: SH[i0].m, i0, pile, runout, atSeventy, n: months };
  }
  const R = { r90: minhWay(AT.get("1990-01"), LAST - AT.get("1990-01")), r00: minhWay(AT.get("2000-01"), LAST - AT.get("2000-01")) };
  const ALL = []; for (let i = 0; i + 456 <= LAST; i++) ALL.push(minhWay(i, 455));
  const ageOf = (k) => 62 + k / 12;
  const lasted = ALL.filter((w) => w.runout == null).length;
  const before = (a) => ALL.filter((w) => w.runout != null && ageOf(w.runout) < a).length;
  const worst = ALL.reduce((a, w) => ((w.runout ?? 1e9) < (a.runout ?? 1e9) ? w : a), ALL[0]);
  const M = {
    SH, AT, LAST, EARLY, FRA, LATE, TOP, early, late, BE, surv, LIFE, ageOf, R, ALL, lasted, before, worst, cola: rules.cola2027.percent,
    gainM: lifetime("m", 70) - lifetime("m", 62), gainF: lifetime("f", 70) - lifetime("f", 62),
  };
  // the renderers refuse to load if the ledger stops saying what the scripts say
  const claim = (ok, what) => { if (!ok) throw new Error(`ep10-kit: claim false: ${what}`); };
  const K = (v) => Math.round(v / 1000);
  claim(EARLY === 1400 && FRA === 2000 && LATE === 2480 && TOP === 1080 && M.cola === 3.6, "checks");
  claim(BE === 221 && early(96) === 134400 && late(336) - early(336) === 124800 && late(396) - early(396) === 189600, "race");
  claim(Math.round(surv("m", 80) * 10) === 6 && Math.round(surv("f", 80) * 10) === 7 && Math.round(62 + LIFE[62].me) === 82 && Math.round(62 + LIFE[62].fe) === 85, "life table");
  claim(Math.round(M.gainM / 1e4) === 4 && Math.round(M.gainF / 1e4) === 7, "lifetime gain");
  claim(Math.round(R.r90.atSeventy / 1e4) === 27 && K(R.r90.pile[437]) === 236 && R.r90.runout == null, "1990 replay");
  claim(K(R.r00.pile[32]) === 33 && K(R.r00.atSeventy) === 149 && K(R.r00.pile[110]) === 72 && R.r00.runout === 287, "2000 replay");
  claim(ALL.length === 1410 && lasted / 1410 > 0.4 && lasted / 1410 < 0.5 && Math.abs(before(90) / 1410 - 1 / 3) < 0.03 && Math.abs(before(85) / 1410 - 0.2) < 0.03, "every start");
  claim(worst.m === "1966-01" && Math.floor(ageOf(worst.runout)) === 78, "worst start");
  return M;
}

export const C = {
  paper: "#fbf3df", ink: "#1d1d1f", skin: "#efc39c", hair: "#2a2522", grey: "#9a9590", muted: "#7a7468", red: "#e5646e", green: "#4caf5c",
  gold: "#ffcf4a", sepia: "#f3e2c2", mint: "#e3f1ea", tuTint: "#eaf0dc", lanTint: "#fbe4de", minh: "#5b8fc7", lan: "#e98a7a", bin: "#f2c14e",
  tu: "#8aa05a", tuDark: "#4f6330", minhDark: "#2e5d8f", lanDark: "#b0574a", cash: "#d9e8c4", orange: "#f0a04b",
};
export const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const monthLabel = (m) => { const [y, mo] = m.split("-"); return `${MON[+mo - 1]} ${y}`; };
export const usd = (v) => `$${Math.round(v).toLocaleString("en-US")}`;
export const k$ = (v) => `$${Math.round(v / 1000).toLocaleString("en-US")}k`;
export const clamp01 = (x) => Math.max(0, Math.min(1, x));
export const fade = (t, at, d = 0.3) => clamp01((t - at) / d);
export const ease = (x) => x * x * (3 - 2 * x);
export const ageText = (k) => { const y = 62 + Math.floor(k / 12), mo = Math.floor(k % 12); return mo ? `${y} y ${mo} m` : `${y}`; };

export function makeKit(ctx, W, H) {
  const FONT = '"Segoe UI", system-ui, sans-serif', MONO = '"Cascadia Mono", Consolas, monospace';
  function text(s, x, y, { size = 48, fill = C.ink, align = "center", weight = 800, mono = false, alpha = 1 } = {}) {
    if (alpha <= 0.01) return;
    ctx.globalAlpha = Math.min(1, alpha); ctx.font = `${weight} ${size}px ${mono ? MONO : FONT}`;
    ctx.fillStyle = fill; ctx.textAlign = align; ctx.fillText(s, x, y); ctx.globalAlpha = 1;
  }
  function shape(fill, draw, lw = 7) {
    ctx.beginPath(); draw();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (lw) { ctx.lineWidth = lw; ctx.strokeStyle = C.ink; ctx.lineJoin = "round"; ctx.stroke(); }
  }
  function person(cx, footY, o) {
    ctx.save(); ctx.translate(cx, footY); ctx.scale(o.s, o.s);
    if (o.hair === "long") shape(C.hair, () => ctx.roundRect(-80, -400, 160, 170, 50), 6);
    if (o.shorts) {
      shape(C.skin, () => { ctx.rect(-40, -100, 32, 100); ctx.rect(8, -100, 32, 100); }, 6);
      shape("#5a6b8c", () => ctx.roundRect(-50, -150, 100, 66, 14), 6);
    } else shape("#4a4f5c", () => { ctx.rect(-45, -112, 38, 112); ctx.rect(7, -112, 38, 112); }, 6);
    const bw = o.belly ? 150 : 132;
    shape(o.shirt, () => ctx.roundRect(-bw / 2, -258, bw, 156, 30));
    shape(o.shirt, () => ctx.roundRect(-bw / 2 - 30, -244, 34, 114, 16), 6);
    ctx.save(); ctx.translate(bw / 2 + 13, -238); ctx.rotate(-(o.wave ?? 0)); shape(o.shirt, () => ctx.roundRect(-17, -6, 34, 114, 16), 6); ctx.restore();
    if (o.collar) shape("#ffffff", () => { ctx.moveTo(-26, -258); ctx.lineTo(0, -232); ctx.lineTo(26, -258); ctx.closePath(); }, 5);
    if (o.pocket) shape(null, () => ctx.rect(14, -228, 30, 28), 4);
    shape(C.skin, () => ctx.ellipse(0, -325, 62, 72, 0, 0, Math.PI * 2));
    if (o.hair === "short") shape(C.hair, () => { ctx.moveTo(-64, -318); ctx.ellipse(0, -330, 66, 76, 0, Math.PI, 0); ctx.lineTo(64, -318); ctx.quadraticCurveTo(40, -372, -10, -366); ctx.quadraticCurveTo(-48, -362, -64, -318); ctx.closePath(); }, 6);
    else if (o.hair === "long") shape(C.hair, () => { ctx.moveTo(-70, -300); ctx.ellipse(0, -330, 72, 82, 0, Math.PI, 0); ctx.lineTo(70, -300); ctx.quadraticCurveTo(58, -360, 10, -362); ctx.quadraticCurveTo(-40, -352, -70, -300); ctx.closePath(); }, 6);
    else if (o.hair === "bowl") shape(C.hair, () => { ctx.moveTo(-68, -320); ctx.ellipse(0, -330, 70, 80, 0, Math.PI, 0); ctx.lineTo(68, -320); ctx.lineTo(60, -352); ctx.lineTo(-60, -352); ctx.closePath(); }, 6);
    else if (o.hair === "receding") {
      shape(C.grey, () => ctx.ellipse(-56, -340, 14, 30, 0.15, 0, Math.PI * 2), 5);
      shape(C.grey, () => ctx.ellipse(56, -340, 14, 30, -0.15, 0, Math.PI * 2), 5);
      shape(C.grey, () => ctx.ellipse(0, -392, 34, 10, 0, 0, Math.PI * 2), 4);
    }
    ctx.lineWidth = 5; ctx.strokeStyle = C.ink;
    if (o.glasses) { ctx.beginPath(); ctx.arc(-24, -330, 16, 0, Math.PI * 2); ctx.moveTo(40, -330); ctx.arc(24, -330, 16, 0, Math.PI * 2); ctx.moveTo(-8, -330); ctx.lineTo(8, -330); ctx.stroke(); }
    ctx.fillStyle = C.ink; ctx.beginPath(); ctx.arc(-24, -330, 6, 0, Math.PI * 2); ctx.arc(24, -330, 6, 0, Math.PI * 2); ctx.fill();
    if (o.mustache) shape(C.grey, () => ctx.roundRect(-26, -305, 52, 11, 5), 4);
    if (o.hat) { shape(C.gold, () => { ctx.moveTo(-40, -392); ctx.lineTo(0, -486); ctx.lineTo(40, -392); ctx.closePath(); }, 6); shape(C.red, () => ctx.arc(0, -490, 12, 0, Math.PI * 2), 5); }
    const my = -296;
    if ((o.mouth ?? 0) > 0.05) shape("#7a2e2e", () => ctx.ellipse(0, my + 2, 14, 4 + 14 * o.mouth, 0, 0, Math.PI * 2), 5);
    else {
      ctx.lineWidth = 6; ctx.beginPath();
      if ((o.mood ?? 1) > 0) ctx.arc(0, my - 8, 22, 0.15 * Math.PI, 0.85 * Math.PI);
      else if (o.mood < 0) ctx.arc(0, my + 20, 20, 1.2 * Math.PI, 1.8 * Math.PI);
      else { ctx.moveTo(-15, my); ctx.lineTo(15, my); }
      ctx.stroke();
    }
    ctx.restore();
  }
  function bubble(cx, bottomY, s, colour, alpha, { size = 36, maxW = 420 } = {}) {
    if (alpha <= 0.01) return;
    ctx.font = `800 ${size}px ${FONT}`;
    const rows = [];
    for (const part of s.split("|")) {
      let row = "";
      for (const w of part.split(" ")) { const t = row ? `${row} ${w}` : w; if (ctx.measureText(t).width > maxW && row) { rows.push(row); row = w; } else row = t; }
      rows.push(row);
    }
    const lh = size * 1.28;
    const bw = Math.max(...rows.map((r) => ctx.measureText(r).width)) + 56, bh = rows.length * lh + 34;
    const bx = Math.max(16, Math.min(W - bw - 16, cx - bw / 2)), by = bottomY - bh - 30;
    ctx.globalAlpha = alpha;
    shape("#ffffff", () => ctx.roundRect(bx, by, bw, bh, 24), 6);
    shape("#ffffff", () => { ctx.moveTo(cx - 16, by + bh - 3); ctx.lineTo(cx, by + bh + 26); ctx.lineTo(cx + 16, by + bh - 3); }, 0);
    ctx.lineWidth = 6; ctx.strokeStyle = C.ink; ctx.beginPath(); ctx.moveTo(cx - 16, by + bh); ctx.lineTo(cx, by + bh + 26); ctx.lineTo(cx + 16, by + bh); ctx.stroke();
    ctx.globalAlpha = 1;
    rows.forEach((r, k) => text(r, bx + bw / 2, by + 17 + size * 1.0 + k * lh, { size, fill: colour, alpha }));
  }
  function card(rows, y, alpha, x = W / 2, w = 1100, lh = 62) {
    if (alpha <= 0.01) return;
    const h = 40 + rows.length * lh;
    ctx.globalAlpha = alpha; shape("#ffffff", () => ctx.roundRect(x - w / 2, y, w, h, 28), 7); ctx.globalAlpha = 1;
    rows.forEach(([s, fill, size], k) => text(s, x, y + lh + 8 + k * lh, { size: size ?? 44, fill: fill ?? C.ink, alpha }));
  }
  function stamp(cx, cy, s, colour, rot, alpha, size = 54) {
    if (alpha <= 0.01) return;
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(rot); ctx.globalAlpha = alpha;
    ctx.font = `900 ${size}px ${FONT}`; const w = ctx.measureText(s).width + size;
    ctx.fillStyle = "#ffffff"; ctx.fillRect(-w / 2, -size * 0.82, w, size * 1.5);
    ctx.lineWidth = 9; ctx.strokeStyle = colour; ctx.strokeRect(-w / 2, -size * 0.82, w, size * 1.5);
    ctx.globalAlpha = 1; text(s, 0, size * 0.3, { size, fill: colour, weight: 900, alpha }); ctx.restore();
  }
  function moneyBag(cx, footY, v, max, rMax = 84) {
    if (v > 50) {
      const r = 16 + rMax * Math.sqrt(Math.min(v, max) / max);
      shape("#9ccf7e", () => ctx.ellipse(cx, footY - r, r, r, 0, 0, Math.PI * 2));
      shape("#9ccf7e", () => { ctx.moveTo(cx - r * 0.3, footY - 2 * r + 6); ctx.lineTo(cx, footY - 2 * r - r * 0.35); ctx.lineTo(cx + r * 0.3, footY - 2 * r + 6); ctx.closePath(); }, 6);
      text("$", cx, footY - r + r * 0.35, { size: Math.max(24, r), fill: "#2f6b2a" });
    } else {
      ctx.setLineDash([10, 8]); shape(null, () => ctx.ellipse(cx, footY - 30, 30, 30, 0, 0, Math.PI * 2), 4); ctx.setLineDash([]);
    }
  }
  // a birthday cake with "62" candles
  function cake(cx, topY, s = 1, flame = 0) {
    ctx.save(); ctx.translate(cx, topY); ctx.scale(s, s);
    shape("#f6d7e6", () => ctx.roundRect(-110, 0, 220, 90, 16), 6);
    shape("#ffffff", () => { ctx.moveTo(-110, 20); for (let x = -110; x <= 110; x += 22) ctx.quadraticCurveTo(x + 11, 44, x + 22, 20); ctx.lineTo(110, 0); ctx.lineTo(-110, 0); ctx.closePath(); }, 0);
    for (const [dx, d] of [[-34, "6"], [34, "2"]]) {
      ctx.font = `900 80px ${FONT}`; ctx.textAlign = "center"; ctx.lineWidth = 8; ctx.strokeStyle = C.ink; ctx.strokeText(d, dx, -10); ctx.fillStyle = C.gold; ctx.fillText(d, dx, -10);
      shape("#ff9a3c", () => ctx.ellipse(dx, -104 + Math.sin(flame + dx) * 3, 9, 16, 0, 0, Math.PI * 2), 4);
    }
    ctx.restore();
  }
  // the Social Security letter, three rows
  function letter(x, y, w, alpha, rows) {
    if (alpha <= 0.01) return;
    const h = 120 + rows.length * 74;
    ctx.globalAlpha = alpha;
    shape("#ffffff", () => ctx.roundRect(x, y, w, h, 12), 6);
    ctx.fillStyle = "#2e4a6b"; ctx.fillRect(x + 6, y + 6, w - 12, 70);
    ctx.globalAlpha = 1;
    text("YOUR SOCIAL SECURITY · per month, in today's money", x + w / 2, y + 54, { size: 30, fill: "#ffffff", alpha });
    rows.forEach(([a, v, colour, al], k) => {
      const yy = y + 140 + k * 74;
      text(`start at ${a}`, x + 40, yy, { size: 44, align: "left", alpha: alpha * al });
      text(v, x + w - 40, yy, { size: 52, align: "right", fill: colour, alpha: alpha * al, weight: 900 });
    });
  }
  // a little person icon (the life-table crowd)
  function icon(cx, cy, s, fill, alpha) {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = fill; ctx.strokeStyle = C.ink; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(cx, cy - s * 0.55, s * 0.28, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.roundRect(cx - s * 0.32, cy - s * 0.22, s * 0.64, s * 0.66, s * 0.2); ctx.fill(); ctx.stroke();
    ctx.globalAlpha = 1;
  }
  return { text, shape, person, bubble, card, stamp, moneyBag, cake, letter, icon, FONT, MONO };
}

export const CAST = {
  L: { s: 0.95, shirt: C.lan, hair: "long" },
  M: { s: 1.0, shirt: C.minh, hair: "short", glasses: true, collar: true },
  BIN: { s: 0.7, shirt: C.bin, hair: "bowl", shorts: true },
  T: { s: 0.98, shirt: C.tu, hair: "receding", glasses: true, mustache: true, belly: true, pocket: true, hat: true },
};

// timing helpers shared by every layout
export function makeTiming(timing, script, maxD = 5) {
  const L = Object.fromEntries(timing.lines.map((l) => [l.id, l]));
  const TEXT = Object.fromEntries(script.lines.map((l) => [l.id, l.text.replace(/\*/g, "")]));
  const MONTH = Object.fromEntries(script.lines.map((l) => [l.id, l.month ?? null]));
  const tw = (id, phrase) => { const l = L[id], k = TEXT[id].indexOf(phrase); if (k < 0) throw new Error(`${id}: no "${phrase}"`); return l.start + (l.end - l.start) * k / TEXT[id].length; };
  const sceneOf = (t) => { let s = timing.lines[0].scene; for (const l of timing.lines) if (t >= l.start - 0.3) s = l.scene; return s; };
  const speaking = (t) => timing.lines.find((l) => t >= l.start && t <= l.end + 0.05) ?? null;
  const lineAt = (t) => { let c = null; for (const l of timing.lines) if (t >= l.start - 0.2) c = l; return c; };
  const keysFor = (scene) => { const k = []; let prev = 0; for (const l of timing.lines) { if (l.scene !== scene || MONTH[l.id] == null) continue; const mo = MONTH[l.id]; if (mo !== prev) k.push({ from: prev, to: mo, at: l.start, d: Math.min(maxD, 1.4 + (mo - prev) / 60) }); prev = mo; } return k; };
  const KEYS = {};
  const monthAt = (scene, t) => { KEYS[scene] ??= keysFor(scene); let m = 0; for (const k of KEYS[scene]) { if (t < k.at) break; m = k.from + (k.to - k.from) * ease(clamp01((t - k.at) / k.d)); } return m; };
  return { L, TEXT, MONTH, tw, sceneOf, speaking, lineAt, monthAt };
}
