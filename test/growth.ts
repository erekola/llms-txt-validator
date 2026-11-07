// Growth check for the tests that say a scan "stays linear". It is not a test file (no .test suffix),
// so `node --test` does not run it; the tests import it. The hosted validator's test files in the
// turva-worker repo carry the same function inline, because that repo's test runner would treat a
// shared file in test/ as a test.
//
// Why a ratio and not a limit in milliseconds. A fixed limit fails on a slow CI runner and lets a
// slow but quadratic scan through. Two inputs of one shape, the second about four times the first,
// are timed instead. A linear scan takes about four times as long on the larger one, a quadratic
// scan about sixteen times, and the limit sits between the two on the log scale: sizes ** 1.5, which
// is 8 for 4x the input and about 22.6 for 8x. Each input is timed several times and the fastest
// run counts, because load on the machine only ever adds time, never removes it. The small input is
// repeated until one sample takes at least 1 ms, so the clock resolution does not decide the ratio and
// the samples stay short: a short sample is likelier to fall between two interruptions of a busy machine.
// The check passes as soon as nine rounds give a ratio under the limit. On a loaded machine the ratio
// of the fastest runs can sit above the limit because the larger input was interrupted more often, so
// more rounds are taken, at most 60 and at most four seconds, before the check fails. A scan that is
// really quadratic stays above the limit through all of them (checked against a deliberately quadratic scan).

import assert from "node:assert/strict";

export type Work = (input: string) => unknown;

async function timeIt(work: Work, input: string, reps: number): Promise<number> {
  const started = performance.now();
  for (let i = 0; i < reps; i++) {
    const out = work(input);
    if (out instanceof Promise) await out;
  }
  return performance.now() - started;
}

// The limit for an input that is `sizes` times larger: the midpoint, on the log scale, between a
// linear scan (sizes) and a quadratic one (sizes squared).
export const growthLimit = (sizes: number): number => sizes ** 1.5;

export async function growthRatio(work: Work, small: string, large: string, limit: number = Infinity): Promise<{ ratio: number; rounds: number }> {
  await timeIt(work, large, 1);
  await timeIt(work, small, 1);
  let reps = 1;
  while (reps < 4096 && (await timeIt(work, small, reps)) < 1) reps *= 2;
  const begun = performance.now();
  let minSmall = Infinity;
  let minLarge = Infinity;
  let rounds = 0;
  for (;;) {
    minSmall = Math.min(minSmall, await timeIt(work, small, reps));
    minLarge = Math.min(minLarge, await timeIt(work, large, reps));
    rounds++;
    const ratio = minLarge / minSmall;
    if (rounds >= 9 && ratio < limit) return { ratio, rounds };
    if (rounds >= 60 || (rounds >= 9 && performance.now() - begun > 4000)) return { ratio, rounds };
  }
}

export async function assertLinear(label: string, work: Work, small: string, large: string, explicitLimit?: number): Promise<void> {
  const sizes = large.length / small.length;
  const limit = explicitLimit ?? growthLimit(sizes);
  const g = await growthRatio(work, small, large, limit);
  assert.ok(g.ratio < limit, label + ": " + sizes.toFixed(1) + "x the input took " + g.ratio.toFixed(1) + "x as long after " + g.rounds + " rounds, limit " + limit.toFixed(1));
}
