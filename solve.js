// Fast exact drop-in for makefun-diff 1.0.0.
//
// The reference rule (makefun-diff 1.0.0, derived from jsdiff 9.0.0's Myers
// line diff): lines are cut after every '\n'; the common prefix is kept,
// then the common suffix; between them Myers' greedy search runs from the
// first lines, keeping on each diagonal the path furthest into the old text,
// deletion winning ties, never past either text's end, no edge diagonal
// pruned, and following every run of equal lines as far as it goes; the
// first path to reach both ends is the script. The patch is rendered with 3
// kept lines around each change run, runs at most 6 kept lines apart sharing
// a hunk, deletions before insertions, and a '%' line after a line that ends
// its text without a newline.
//
// Speed comes from three things. First, one Map pass interns both texts'
// lines to ids (a last line with no newline gets a fresh id, so it never
// equals a line that has one), and the search then compares integers in
// Int32Arrays. Second, the frontier lives only in a triangular trace: level
// d - 1 is read straight from the trace, the deletion source of a diagonal
// is the insertion source the previous iteration read, carried in a local,
// and each (d, k) costs one load and one store. Third, the patch is emitted
// as pieces joined once, with no intermediate string per line.

/** A kept line's run kind. */
const KEEP = 0;
/** A deleted line's run kind. */
const DELETE = 1;
/** An inserted line's run kind. */
const INSERT = 2;

/** How many kept lines a hunk shows before and after each change run. */
const CONTEXT = 3;

/**
 * The edit script of the middle slices as [kind, count] runs, kind 0 keep,
 * 1 delete, 2 insert, in order. `a` and `b` are Int32Array views of the
 * middle slices' interned line ids, `n` / `m` lines long.
 */

// Scratch frontier trace, reused across calls. Every entry a run reads was
// written by that same run (the forward pass writes rows 0..D in full), so
// reuse changes no answer; it only skips re-allocating the workspace per
// case. It holds no result and no input between cases.
let traceBuf = new Int32Array(0);
let traceCap = 0;

function myersRuns(a, n, b, m) {
  if (n === 0) return m === 0 ? [] : [[INSERT, m]];
  if (m === 0) return [[DELETE, n]];

  const maxD = n + m;
  // The trace holds every level's frontier, one integer per (d, k), packed
  // triangularly: level d starts at d * (d + 1) / 2 and its d + 1 diagonals
  // follow in k order. It is the whole backtrack record, and the only
  // frontier kept: level d reads level d - 1 from it directly.
  let trace = traceBuf;
  let cap = traceCap;
  if (cap === 0) {
    trace = new Int32Array(1 << 23);
    traceBuf = trace;
    traceCap = cap = 1 << 23;
  }
  const grow = (need) => {
    if (need <= cap) return;
    let next = cap;
    while (next < need) next *= 2;
    const bigger = new Int32Array(next);
    bigger.set(trace);
    trace = bigger;
    traceBuf = bigger;
    traceCap = cap = next;
  };

  // d = 0: the snake from the first lines. (Reading a view past its end
  // gives undefined, never equal to a line id, so one bound suffices: the
  // new index cannot pass its end while the old one has not.)
  let x = 0;
  while (x < n && a[x] === b[x]) x++;
  trace[0] = x;
  if (x === n && x === m) return x > 0 ? [[KEEP, x]] : [];

  let D = -1;
  let K = 0;
  outer: for (let d = 1; d <= maxD; d++) {
    const row = (d * (d + 1)) >> 1;
    grow(row + d + 1);
    const prev = ((d - 1) * d) >> 1;
    let xdPrev = -1; // the (d - 1)-path on k - 1; -1 when that diagonal is not there
    let tp = prev; // trace index of the (d - 1)-path on k + 1
    let tw = row; // trace index this level writes
    for (let k = -d; k <= d; k += 2, tp++) {
      const xiPrev = k < d ? trace[tp] : -1;
      // Deletion: one old line past the (d - 1)-path on k - 1, valid while
      // an old line is left. Insertion: one new line past the (d - 1)-path
      // on k + 1, valid while a new line is left (the new line it consumes
      // is at index xiPrev - 1 - k). The deletion wins the tie.
      const xDel = xdPrev >= 0 && xdPrev < n ? xdPrev + 1 : -1;
      const xIns = xiPrev >= 0 && xiPrev - 1 - k < m ? xiPrev : -1;
      let xx;
      if (xDel >= xIns) {
        if (xDel < 0) {
          trace[tw++] = -1;
          xdPrev = xiPrev;
          continue;
        }
        xx = xDel;
      } else {
        xx = xIns;
      }
      let y = xx - k;
      while (xx < n && a[xx] === b[y]) {
        xx++;
        y++;
      }
      trace[tw++] = xx;
      if (xx === n && y === m) {
        D = d;
        K = k;
        break outer;
      }
      xdPrev = xiPrev;
    }
  }
  if (D < 0) throw new Error('makefun-diff: the search ended without reaching both ends');

  // Walk back from (D, K): at each level the step into (d, k) is the one
  // the forward rule picked, and the snake before it is kept lines.
  const seg = [];
  let d = D;
  let k = K;
  let xEnd = n;
  while (d > 0) {
    const prev = ((d - 1) * d) >> 1;
    // The two parent diagonals; the outer ones do not exist at level d - 1.
    const xdPrev = k > -d ? trace[prev + ((k + d - 2) >> 1)] : -1;
    const xiPrev = k < d ? trace[prev + ((k + d) >> 1)] : -1;
    const xDel = xdPrev >= 0 && xdPrev < n ? xdPrev + 1 : -1;
    const xIns = xiPrev >= 0 && xiPrev - 1 - k < m ? xiPrev : -1;
    let xPre;
    let kind;
    let kPrev;
    let parentX;
    if (xDel >= xIns) {
      if (xDel < 0) throw new Error('makefun-diff: backtrack lost the path');
      xPre = xDel;
      kind = DELETE;
      kPrev = k - 1;
      parentX = xdPrev;
    } else {
      xPre = xIns;
      kind = INSERT;
      kPrev = k + 1;
      parentX = xiPrev;
    }
    // The snake at this level runs from xPre to the level's post-snake x,
    // read back from the trace (xEnd already holds the parent's, for the
    // next round and for the d = 0 snake at the end).
    const cur = (d * (d + 1)) >> 1;
    const xCur = trace[cur + ((k + d) >> 1)];
    if (xCur - xPre > 0) seg.push([KEEP, xCur - xPre]);
    seg.push([kind, 1]);
    xEnd = parentX;
    k = kPrev;
    d--;
  }
  if (xEnd > 0) seg.push([KEEP, xEnd]);

  // Reverse the segments into forward order, merging runs of a kind.
  const runs = [];
  for (let i = seg.length - 1; i >= 0; i--) {
    const s = seg[i];
    const last = runs[runs.length - 1];
    if (last !== undefined && last[0] === s[0]) last[1] += s[1];
    else runs.push([s[0], s[1]]);
  }
  return runs;
}

/**
 * make.fun's own patch of the two texts, as one string: a first line
 * 'makefun-diff/1 old=N new=M hunks=H deleted=D inserted=I', then each
 * hunk's '@ os ol ns nl' line and one line per line it covers. `oldParts` /
 * `newParts` are the texts split after every '\n'; `oldBare` / `newBare`
 * say the last line of each ends its text with no newline.
 */
function renderPatch(oldParts, oldBare, newParts, newBare, n, m, runs) {
  // The change runs: each a stretch of deletions and insertions between two
  // kept lines, at old line o and new line p.
  const changes = [];
  let o = 0;
  let p = 0;
  let deleted = 0;
  let inserted = 0;
  for (const r of runs) {
    if (r[0] === KEEP) {
      o += r[1];
      p += r[1];
      continue;
    }
    let c = changes[changes.length - 1];
    if (c === undefined || c.o + c.dels !== o || c.p + c.ins !== p) {
      c = { o, p, dels: 0, ins: 0 };
      changes.push(c);
    }
    if (r[0] === DELETE) {
      c.dels += r[1];
      o += r[1];
      deleted += r[1];
    } else {
      c.ins += r[1];
      p += r[1];
      inserted += r[1];
    }
  }

  // The hunks: change runs at most 2 * CONTEXT kept lines apart share one.
  const hunks = [];
  for (const c of changes) {
    const h = hunks[hunks.length - 1];
    const prev = h !== undefined ? h[h.length - 1] : undefined;
    if (prev !== undefined && c.o - (prev.o + prev.dels) <= 2 * CONTEXT) h.push(c);
    else hunks.push([c]);
  }

  // One line per covered line, as pieces: the op, the line's part, and its
  // newline ('\n%\n' when the line ends its text with no newline).
  const out = [`makefun-diff/1 old=${n} new=${m} hunks=${hunks.length} deleted=${deleted} inserted=${inserted}\n`];
  for (const h of hunks) {
    const first = h[0];
    const last = h[h.length - 1];
    const oldStart = Math.max(0, first.o - CONTEXT);
    const newStart = first.p - (first.o - oldStart);
    const after = Math.min(CONTEXT, n - (last.o + last.dels));
    const oldEnd = last.o + last.dels + after;
    const newEnd = last.p + last.ins + after;
    out.push(`@ ${oldStart + 1} ${oldEnd - oldStart} ${newStart + 1} ${newEnd - newStart}\n`);
    let at = oldStart;
    for (const c of h) {
      for (; at < c.o; at++) {
        out.push('=', oldParts[at], oldBare && at === n - 1 ? '\n%\n' : '\n');
      }
      for (let i = 0; i < c.dels; i++) {
        const j = c.o + i;
        out.push('-', oldParts[j], oldBare && j === n - 1 ? '\n%\n' : '\n');
      }
      for (let i = 0; i < c.ins; i++) {
        const j = c.p + i;
        out.push('+', newParts[j], newBare && j === m - 1 ? '\n%\n' : '\n');
      }
      at = c.o + c.dels;
    }
    for (; at < oldEnd; at++) {
      out.push('=', oldParts[at], oldBare && at === n - 1 ? '\n%\n' : '\n');
    }
  }
  return out.join('');
}

/** makefun-diff 1.0.0's answer for one case's input. */
export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('makefun-diff: the input is { old, new }, two strings');
  }
  // Split both texts after every '\n'. A last line with no '\n' is a line
  // too, and it equals no line that has one.
  const oldParts = input.old.split('\n');
  const newParts = input.new.split('\n');
  const n = oldParts.length - (oldParts[oldParts.length - 1] === '' ? 1 : 0);
  const m = newParts.length - (newParts[newParts.length - 1] === '' ? 1 : 0);
  const oldBare = n > 0 && oldParts.length === n;
  const newBare = m > 0 && newParts.length === m;

  // Intern both texts' lines to ids through one map, so equal lines share
  // an id and the search below compares integers, not strings. A bare last
  // line takes a fresh id of its own (shared when both texts end bare on
  // the same part), so it never equals a line that ends with a newline.
  const ids = new Map();
  let next = 0;
  const A = new Int32Array(n);
  const aEnd = oldBare ? n - 1 : n;
  for (let i = 0; i < aEnd; i++) {
    const line = oldParts[i];
    let id = ids.get(line);
    if (id === undefined) {
      id = next++;
      ids.set(line, id);
    }
    A[i] = id;
  }
  const B = new Int32Array(m);
  const bEnd = newBare ? m - 1 : m;
  for (let i = 0; i < bEnd; i++) {
    const line = newParts[i];
    let id = ids.get(line);
    if (id === undefined) {
      id = next++;
      ids.set(line, id);
    }
    B[i] = id;
  }
  if (oldBare && newBare && oldParts[n - 1] === newParts[m - 1]) {
    A[n - 1] = next;
    B[m - 1] = next;
    next++;
  } else {
    if (oldBare) A[n - 1] = next++;
    if (newBare) B[m - 1] = next++;
  }

  // The common prefix, then the common suffix of what is left.
  let prefix = 0;
  while (prefix < n && prefix < m && A[prefix] === B[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && A[n - 1 - suffix] === B[m - 1 - suffix]) suffix++;

  const middle = myersRuns(A.subarray(prefix, n - suffix), n - prefix - suffix, B.subarray(prefix, m - suffix), m - prefix - suffix);

  // Stitch the runs: prefix keeps, the middle script, suffix keeps.
  const runs = [];
  const push = (kind, count) => {
    if (count <= 0) return;
    const last = runs[runs.length - 1];
    if (last !== undefined && last[0] === kind) last[1] += count;
    else runs.push([kind, count]);
  };
  push(KEEP, prefix);
  for (const r of middle) push(r[0], r[1]);
  push(KEEP, suffix);

  return renderPatch(oldParts, oldBare, newParts, newBare, n, m, runs);
}
