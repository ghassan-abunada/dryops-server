'use strict';
// ── Psychrometrics ───────────────────────────────────────────────────────────
// Twin of the DryOps app's lib/psychrometrics.ts — same Magnus constants, same
// rounding, so the GPP in a JobNimbus note matches what the tech saw on screen.

const STANDARD_HPA = 1013.25;
const fToC = (f) => ((f - 32) * 5) / 9;
const cToF = (c) => (c * 9) / 5 + 32;
const saturationHpa = (c) => 6.1094 * Math.exp((17.625 * c) / (c + 243.04));
const valid = (t, rh) => typeof t === 'number' && Number.isFinite(t) && typeof rh === 'number' && Number.isFinite(rh) && rh >= 0 && rh <= 100;

/** Grains per pound, whole grains; null when inputs are missing or out of range. */
function gpp(tempF, rh, pressureHpa = STANDARD_HPA) {
  if (!valid(tempF, rh)) return null;
  const e = saturationHpa(fToC(tempF)) * (rh / 100);
  if (e >= pressureHpa) return null;
  const w = (0.62198 * e) / (pressureHpa - e);
  return Math.round(w * 7000);
}

/** Dew point °F to a tenth; null when inputs are missing or RH is 0. */
function dewPointF(tempF, rh) {
  if (!valid(tempF, rh) || rh <= 0) return null;
  const c = fToC(tempF);
  const gamma = Math.log(rh / 100) + (17.625 * c) / (c + 243.04);
  const dp = (243.04 * gamma) / (17.625 - gamma);
  return Math.round(cToF(dp) * 10) / 10;
}

module.exports = { gpp, dewPointF };
