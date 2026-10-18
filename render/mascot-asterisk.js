// The Asterisk: the channel's mascot, chosen by the founder 2026-10-03.
//
// It is the fine print made into a character. Its one job on screen is to pop up
// and point at the assumption that flips the answer, which is the channel's whole
// promise. It is a SKEPTIC that represents the viewer, never a person in the data:
// it may ask "what if you started in 1972?", it never "took a loan in 1972".
//
// drawAsterisk is a pure function of its arguments, like every renderer here, so
// capture-animation can still split frames across workers. Mouth openness is
// meant to be driven from Azure TTS viseme timings, never hand-keyed.
//
// Colour: a yellow nothing in the data palette uses. Teal, orange and red already
// MEAN invest / pay down / warning on this channel, and a mascot in one of them
// would make every chart it stands next to ambiguous.
export const ASTERISK = {
  body: "#ffcf4a",
  shade: "#e0ad25",
  ink: "#0d1117",
  white: "#ffffff",
  blush: "#ff9f80",
};

// The canonical look, founder pick 2026-10-03 (variant 3 + the tooth): white
// sticker outline, monocle over the right eye, one buck tooth. Every production
// use passes these unless a scene has a reason not to.
export const CANON_TRAITS = { outline: true, monocle: true, tooth: true };

// Expressions: brows (angles in radians, + = inner end down), eye squint 0..1,
// pupil offset, mouth shape. Six states are the minimum set the format needs.
export const EXPRESSIONS = {
  skeptical: { browL: 0.10, browR: -0.38, raiseR: 10, squintL: 0.45, squintR: 0, look: [0.35, 0.1], mouth: "flat-tilt" },
  surprised: { browL: -0.15, browR: 0.15, raiseL: 12, raiseR: 12, squintL: 0, squintR: 0, look: [0, 0], mouth: "o", eyeScale: 1.15 },
  pointing: { browL: 0.18, browR: 0.18, squintL: 0.15, squintR: 0.15, look: [0.6, 0.25], mouth: "smirk" },
  smug: { browL: 0.25, browR: 0.25, squintL: 0.5, squintR: 0.5, look: [-0.2, 0], mouth: "grin", blush: true },
  confused: { browL: -0.3, browR: 0.25, raiseL: 8, squintL: 0, squintR: 0.3, look: [-0.3, -0.35], mouth: "wobble" },
  talking: { browL: 0, browR: 0, squintL: 0.1, squintR: 0.1, look: [0.1, 0], mouth: "talk" },
};

const ARM_ANGLES = [-90, -30, 30, 90, 150, 210].map((d) => (d * Math.PI) / 180);

/**
 * @param ctx      canvas 2d context
 * @param x,y      centre
 * @param size     overall radius, tip to centre
 * @param opts     { expression, mouthOpen 0..1 (talking only), point: angle in
 *                  radians for the pointing arm or null, tilt radians, squash 0..1 }
 */
export function drawAsterisk(ctx, x, y, size, opts = {}) {
  const e = EXPRESSIONS[opts.expression ?? "skeptical"];
  const s = size / 100; // design units: arms reach 100 from centre
  const tilt = opts.tilt ?? 0;
  const squash = opts.squash ?? 0;

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(tilt);
  ctx.scale(s * (1 + squash * 0.12), s * (1 - squash * 0.12));

  // Arms. One arm is replaced by the pointing arm when `point` is set, chosen as
  // the arm nearest the target so the shape never grows a seventh spoke.
  const pointAt = opts.point ?? null;
  let skip = -1;
  if (pointAt !== null) {
    let best = Infinity;
    ARM_ANGLES.forEach((a, k) => {
      const d = Math.abs(Math.atan2(Math.sin(a - pointAt), Math.cos(a - pointAt)));
      if (d < best) { best = d; skip = k; }
    });
  }
  // Optional traits, all off by default so the base character is unchanged:
  // { outline, monocle, hair, pen, bandage, tooth, eyeL, eyeR (scale) }.
  const tr = opts.traits ?? {};
  // The red pen replaces the lower-right spoke unless the pointing arm took it.
  const penArm = tr.pen && skip !== 2 ? 2 : -1;

  const arm = (angle, length, width, fill) => {
    ctx.save();
    ctx.rotate(angle);
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.roundRect(0, -width / 2, length, width, width / 2);
    ctx.fill();
    ctx.restore();
  };
  // One silhouette pass. Drawn twice for the sticker outline: first padded in ink,
  // then in the body colour, so the outline never needs a stroke per part.
  const silhouette = (fill, pad) => {
    ARM_ANGLES.forEach((a, k) => { if (k !== skip && k !== penArm) arm(a, 100 + pad, 34 + pad * 2, fill); });
    if (pointAt !== null) arm(pointAt, 132 + pad, 30 + pad * 2, fill);
    if (penArm >= 0) arm(ARM_ANGLES[penArm], 40 + pad, 34 + pad * 2, fill);
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(0, 0, 54 + pad, 0, Math.PI * 2);
    ctx.fill();
  };
  // faceOnly: the 3D renderer builds body and arms as geometry and only borrows
  // the face from here, painted onto a texture, so expressions stay single-source.
  if (!opts.faceOnly) {
  // White, like a die-cut sticker: an ink outline vanishes on the channel's
  // near-black background, which is the first capture's lesson.
  if (tr.outline) silhouette(ASTERISK.white, 8);
  silhouette(ASTERISK.body, 0);
  if (pointAt !== null) {
    // fingertip: a small rounded nub so it reads as a pointer, not a longer spoke
    ctx.save();
    ctx.rotate(pointAt);
    ctx.fillStyle = ASTERISK.shade;
    ctx.beginPath();
    ctx.arc(126, 0, 13, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Red pen held in place of a spoke: it marks up claims. Red is the channel's
  // warning colour, which is exactly what a correction is.
  if (penArm >= 0) {
    ctx.save();
    ctx.rotate(ARM_ANGLES[penArm]);
    if (tr.outline) {
      ctx.fillStyle = ASTERISK.white;
      ctx.beginPath(); ctx.roundRect(28, -21, 76, 42, 8); ctx.fill();
      ctx.beginPath(); ctx.moveTo(100, -21); ctx.lineTo(128, 0); ctx.lineTo(100, 21); ctx.closePath(); ctx.fill();
    }
    ctx.fillStyle = "#e5646e";
    ctx.beginPath(); ctx.roundRect(34, -13, 62, 26, 5); ctx.fill();
    ctx.fillStyle = "#f0f4f8";
    ctx.fillRect(34, -13, 12, 26);
    ctx.fillStyle = "#c9c2b5";
    ctx.beginPath(); ctx.moveTo(96, -13); ctx.lineTo(118, 0); ctx.lineTo(96, 13); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#e5646e";
    ctx.beginPath(); ctx.moveTo(110, -4); ctx.lineTo(118, 0); ctx.lineTo(110, 4); ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  // Bandage on the upper-left spoke: it has been through 1929 and 2008.
  if (tr.bandage) {
    ctx.save();
    ctx.rotate(ARM_ANGLES[4]);
    ctx.fillStyle = "#e8dccb";
    ctx.fillRect(64, -19, 18, 38);
    ctx.strokeStyle = "#b8a990";
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(68, -8); ctx.lineTo(78, 8); ctx.moveTo(78, -8); ctx.lineTo(68, 8); ctx.stroke();
    ctx.restore();
  }

  // One stubborn hair on the top spoke.
  if (tr.hair) {
    const curl = () => {
      ctx.beginPath();
      ctx.moveTo(0, -104);
      ctx.bezierCurveTo(-4, -140, 26, -146, 18, -126);
      ctx.bezierCurveTo(14, -118, 4, -124, 10, -132);
      ctx.stroke();
    };
    ctx.lineCap = "round";
    if (tr.outline) { ctx.strokeStyle = ASTERISK.white; ctx.lineWidth = 15; curl(); }
    ctx.strokeStyle = ASTERISK.body;
    ctx.lineWidth = 7;
    curl();
  }
  }

  // Eyes. Big whites on purpose: eye contact is what a thumbnail face is for.
  const eyeBase = 17 * (e.eyeScale ?? 1);
  let eyeR = eyeBase;
  const eye = (cx, squint) => {
    eyeR = eyeBase * ((cx < 0 ? tr.eyeL : tr.eyeR) ?? 1);
    // The squint CLIPS the eye rather than painting a body-coloured lid over it:
    // a painted lid shows as a flat yellow block once the face is a texture on a
    // shaded 3D body.
    ctx.save();
    if (squint > 0) {
      ctx.beginPath();
      ctx.rect(cx - eyeR - 2, -6 - eyeR + eyeR * squint, eyeR * 2 + 4, eyeR * 3);
      ctx.clip();
    }
    ctx.fillStyle = ASTERISK.white;
    ctx.beginPath();
    ctx.ellipse(cx, -6, eyeR, eyeR * (1 - squint * 0.55), 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = ASTERISK.ink;
    ctx.beginPath();
    ctx.arc(cx + e.look[0] * 7, -6 + e.look[1] * 6, 7.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };
  eye(-21, e.squintL ?? 0);
  eye(21, e.squintR ?? 0);

  // Monocle over the right eye, on a chain: the fine-print reader.
  if (tr.monocle) {
    const r = eyeBase * (tr.eyeR ?? 1) + 8;
    ctx.fillStyle = "rgba(160, 220, 255, 0.18)";
    ctx.beginPath(); ctx.arc(21, -6, r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = ASTERISK.ink;
    ctx.lineWidth = 5;
    ctx.beginPath(); ctx.arc(21, -6, r, 0, Math.PI * 2); ctx.stroke();
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(21 + r * 0.7, -6 + r * 0.7);
    ctx.quadraticCurveTo(52, 40, 40, 58);
    ctx.stroke();
  }

  // Brows
  const brow = (cx, angle, raise = 0, side) => {
    ctx.save();
    ctx.translate(cx, -32 - raise);
    ctx.rotate(side * angle);
    ctx.strokeStyle = ASTERISK.ink;
    ctx.lineWidth = 6;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(-12, 0);
    ctx.lineTo(12, 0);
    ctx.stroke();
    ctx.restore();
  };
  brow(-21, e.browL, e.raiseL ?? 0, 1);
  brow(21, e.browR, e.raiseR ?? 0, -1);

  if (e.blush) {
    ctx.fillStyle = ASTERISK.blush;
    ctx.globalAlpha *= 0.55;
    ctx.beginPath(); ctx.ellipse(-34, 16, 9, 5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(34, 16, 9, 5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha /= 0.55;
  }

  // Mouth
  ctx.strokeStyle = ASTERISK.ink;
  ctx.fillStyle = ASTERISK.ink;
  ctx.lineWidth = 5;
  ctx.lineCap = "round";
  ctx.beginPath();
  // speaking: brows and eyes keep the expression, the mouth follows the voice.
  const mouthKind = opts.speaking ? "talk" : e.mouth;
  switch (mouthKind) {
    case "flat-tilt": ctx.moveTo(-14, 26); ctx.lineTo(12, 21); ctx.stroke(); break;
    case "o": ctx.ellipse(0, 26, 9, 12, 0, 0, Math.PI * 2); ctx.fill(); break;
    case "smirk": ctx.moveTo(-12, 24); ctx.quadraticCurveTo(4, 30, 16, 18); ctx.stroke(); break;
    case "grin": ctx.moveTo(-18, 20); ctx.quadraticCurveTo(0, 38, 18, 20); ctx.closePath(); ctx.fill(); break;
    case "wobble": ctx.moveTo(-14, 26); ctx.quadraticCurveTo(-7, 20, 0, 26); ctx.quadraticCurveTo(7, 32, 14, 26); ctx.stroke(); break;
    case "talk": {
      const open = Math.max(0, Math.min(1, opts.mouthOpen ?? 0.5));
      ctx.ellipse(0, 25, 13, 2 + open * 11, 0, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
  }
  // A single buck tooth, hung from the top edge of whatever mouth is showing.
  // Part of the canonical look since 2026-10-03, so it must exist in every state.
  if (tr.tooth) {
    const open = Math.max(0, Math.min(1, opts.mouthOpen ?? 0.5));
    const ty = {
      "flat-tilt": 23, o: 15, smirk: 26, grin: 22, wobble: 25, talk: 24 - open * 11,
    }[mouthKind];
    ctx.fillStyle = ASTERISK.white;
    ctx.fillRect(-2, ty, 9, 9);
  }
  ctx.restore();
}
