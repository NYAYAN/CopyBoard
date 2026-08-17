// Vertical scroll-capture stitching.
//
// The user picks a region, then scrolls the app underneath it themselves while we sample
// that region ~20 times a second. Each frame overlaps the previous one; this module works
// out BY HOW MUCH and reports which rows of the new frame are content we haven't seen yet.
// The caller owns the pixels (canvas tiles); everything here is pure arithmetic over row
// profiles, which is what makes it testable without a DOM.
//
// Matching is done on a ROW PROFILE rather than the pixels: each row is reduced to ~64
// sampled luma values, so a 1200x800 frame becomes 51KB instead of 3.8MB and an offset
// search is a 1-D sequence match instead of 2-D template matching. Only the profile of the
// base frame is retained, never the frame itself.
//
// Three things make real pages hard, and each has a defence here:
//   - Sticky headers/footers don't move with the content. Left in the match band they bias
//     every score toward "no scroll"; appended blindly they stripe the output with repeats.
//     measureStatic() finds them and both the band and the append window exclude them.
//   - Repetitive content (tables, lists) matches equally well at several offsets. The
//     runner-up test rejects those frames unless the scroll velocity from the last commit
//     picks a clear winner.
//   - Scrolling faster than the region is tall leaves no overlap at all. That frame is
//     rejected and the base is HELD, so the capture recovers as soon as the content comes
//     back into range instead of silently splicing across the gap.

export const DEFAULTS = {
    // Row profile
    sampleCols: 64,
    leftMarginPct: 0.02,     // window chrome / focus rings hug the left edge
    rightMarginPct: 0.05,    // the scrollbar lives here and moves at its OWN rate — sampling
    // it injects a column of noise into every row

    // Offset search
    coarseRowStep: 4,        // coarse sweep granularity (rows AND candidate offsets)
    coarseColStep: 2,
    refineSeeds: 3,          // coarse peaks re-scored at full resolution
    minOverlapRows: 48,      // rows that must still overlap for a match to mean anything
    maxScrollPct: 0.5,       // a frame that moved more than half the band is not trustworthy
    minScroll: 3,            // below this the frame is treated as "not scrolled yet"

    // Confidence
    acceptScore: 12,         // mean per-sample luma difference; a true match sits near 0-3
    ambiguityRatio: 0.75,    // best must beat the runner-up by 25% to stand on its own
    hintTolerance: 24,       // when ambiguous, how far from the last offset a candidate may sit
    // Scores are means, so a large offset is judged on the handful of rows that still
    // overlap — and a handful of rows agree by accident far too easily. Left uncorrected
    // this hands every tie to the largest offset on the board: on a page ending in a list
    // or a flat background, a 450px phantom scroll matched on 50 rows beat the true 50px
    // scroll matched on 450. The penalty prices in how much evidence a candidate actually
    // rests on, which costs a true match almost nothing and breaks ties toward more overlap.
    overlapPenalty: 6,

    // Sticky chrome
    stickyTolerance: 3,      // per-sample luma difference still counted as "unchanged"
    stickyMinScroll: 8,      // never judge staticness off a frame that barely moved
    maxStickyPct: 0.35,      // a "header" larger than this is a misread, not chrome
    stickyFreezeAfter: 5,    // stop revising the estimate once the capture is under way

    // Output bounds — a runaway page must not take the app down with it. RGBA in memory is
    // 4 bytes a pixel and composing the final image needs a second copy, so the area cap is
    // set in pixels rather than rows: 50MP is ~200MB accumulated, ~400MB at the moment of
    // export. Tall-and-narrow captures get more rows than wide ones, which is the right way
    // round for a scroll capture.
    //
    // The row cap is a canvas limit rather than a memory one. 16384 is the largest side
    // every GPU Chromium runs on can back with a texture; past it the canvas falls off the
    // hardware path and, on some drivers, comes back blank — which would turn a long
    // capture the user just spent a minute on into an empty image.
    maxPixels: 50e6,
    maxHeight: 16384,
    // Width of the image the caller is actually building, when that differs from the width
    // of the frames fed in here. The renderer matches on a narrow strip downscaled from the
    // crop — same rows, ~20x less pixel readback per frame — so the frames it pushes are
    // ~128px wide while the output is the full region. Left unset the cap would be computed
    // from the strip and let the real image grow twenty times past its budget.
    outputWidth: 0
};

// Evenly spaced sample columns, edges excluded (see leftMarginPct/rightMarginPct).
function pickColumns(width, o) {
    const left = Math.floor(width * o.leftMarginPct);
    const right = Math.max(left + 1, Math.ceil(width * (1 - o.rightMarginPct)));
    const span = right - left;
    const n = Math.max(1, Math.min(o.sampleCols, span));
    const cols = new Int32Array(n);
    for (let i = 0; i < n; i++) {
        cols[i] = left + Math.min(span - 1, Math.floor((i + 0.5) * span / n));
    }
    return cols;
}

// Box-average groups of `rowStep` rows into one, keeping every `colStep`-th sample.
//
// Averaging rather than skipping is the whole point. A sweep over skipped rows only ever
// tests offsets that are multiples of the step, so a 37px scroll is never a candidate and
// the coarse pass reports a trough somewhere else entirely. Averaged rows blur across the
// step, so the coarse trough lands within half a step of the true offset whatever it is,
// and the full-resolution refinement below finishes the job.
function downsample(profile, rowStep, colStep) {
    const s = profile.cols;
    const outCols = Math.ceil(s / colStep);
    const outRows = Math.floor(profile.height / rowStep);
    const data = new Uint8Array(outRows * outCols);

    for (let y = 0; y < outRows; y++) {
        const dst = y * outCols;
        for (let c = 0, i = 0; c < s; c += colStep, i++) {
            let sum = 0;
            for (let r = 0; r < rowStep; r++) sum += profile.data[(y * rowStep + r) * s + c];
            data[dst + i] = (sum / rowStep) | 0;
        }
    }
    return { height: outRows, cols: outCols, data };
}

// Reduce a frame to one luma value per sampled column per row, plus the coarse level the
// offset search sweeps first.
// `frame` is anything ImageData-shaped: { width, height, data } with RGBA bytes.
export function buildProfile(frame, opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    const { width, height, data } = frame;
    const cols = pickColumns(width, o);
    const s = cols.length;
    const out = new Uint8Array(height * s);

    for (let y = 0; y < height; y++) {
        const rowBase = y * width * 4;
        const dst = y * s;
        for (let i = 0; i < s; i++) {
            const p = rowBase + cols[i] * 4;
            // Rec.601 luma with integer weights — (77R + 150G + 29B) >> 8.
            out[dst + i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
        }
    }

    const profile = { height, cols: s, data: out };
    profile.coarse = downsample(profile, o.coarseRowStep, o.coarseColStep);
    return profile;
}

// Mean |difference| between cur.row[y] and base.row[y + offset] across the band.
// Sub-stepping rows/columns is what makes the coarse sweep affordable.
function bandScore(base, cur, offset, top, bottom, rowStep, colStep) {
    const s = cur.cols;
    const a = cur.data, b = base.data;
    let sum = 0, count = 0;

    for (let y = top; y + offset < bottom; y += rowStep) {
        const ai = y * s, bi = (y + offset) * s;
        for (let i = 0; i < s; i += colStep) {
            const d = a[ai + i] - b[bi + i];
            sum += d < 0 ? -d : d;
            count++;
        }
    }
    return count ? sum / count : Infinity;
}

// Mean |difference| between two rows AT THE SAME y — the test for "this row did not move".
function rowDistance(base, cur, y) {
    const s = cur.cols;
    const ai = y * s;
    let sum = 0;
    for (let i = 0; i < s; i++) {
        const d = cur.data[ai + i] - base.data[ai + i];
        sum += d < 0 ? -d : d;
    }
    return sum / s;
}

// How far the content moved between two profiles, as a ranked candidate list.
//
// Coarse sweep over the averaged pyramid level first, then the few most promising troughs
// re-scored at full row/column resolution. Refining more than one trough matters: a
// near-tie at 1/4 resolution routinely reorders once every row is compared, and taking the
// coarse winner on faith would lock in the wrong offset on repetitive content.
// Candidates are RANKED on the overlap-adjusted score but report their RAW one: ranking is
// a judgement about which reading is most likely, while the caller's accept and ambiguity
// tests are judgements about how well the pixels actually agree, and the penalty has no
// business in those.
export function findOffset(base, cur, band, opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    const { top, bottom } = band;
    const bandRows = bottom - top;
    const maxShift = Math.min(Math.floor(bandRows * o.maxScrollPct), bandRows - o.minOverlapRows);
    if (maxShift < o.minScroll) return { candidates: [], reason: 'band-too-short' };

    const prior = (d) => o.overlapPenalty * (d / bandRows);

    const step = o.coarseRowStep;
    const cTop = Math.ceil(top / step);
    const cBottom = Math.floor(bottom / step);
    const cMax = Math.floor(maxShift / step);

    const coarse = [];
    for (let dc = 0; dc <= cMax; dc++) {
        const d = dc * step;
        coarse.push({ d, rank: bandScore(base.coarse, cur.coarse, dc, cTop, cBottom, 1, 1) + prior(d) });
    }
    coarse.sort((x, y) => x.rank - y.rank);

    // Seeds must be genuinely distinct offsets, not three points on the same trough.
    const seeds = [];
    for (const c of coarse) {
        if (seeds.some(s => Math.abs(s - c.d) <= step)) continue;
        seeds.push(c.d);
        if (seeds.length >= o.refineSeeds) break;
    }

    const candidates = [];
    for (const seed of seeds) {
        const lo = Math.max(0, seed - step);
        const hi = Math.min(maxShift, seed + step);
        let bestD = seed, bestScore = Infinity, bestRank = Infinity;
        for (let d = lo; d <= hi; d++) {
            const sc = bandScore(base, cur, d, top, bottom, 1, 1);
            if (sc + prior(d) < bestRank) { bestRank = sc + prior(d); bestScore = sc; bestD = d; }
        }
        candidates.push({ offset: bestD, score: bestScore, rank: bestRank });
    }
    candidates.sort((x, y) => x.rank - y.rank);
    return { candidates, reason: null };
}

// Rows at the top and bottom that did NOT move even though the content did — sticky chrome.
// Only meaningful when the caller already knows the frame scrolled (see stickyMinScroll):
// on a still frame every row is "unchanged" and this would call the whole region a header.
export function measureStatic(base, cur, opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    const h = cur.height;

    let header = 0;
    while (header < h && rowDistance(base, cur, header) <= o.stickyTolerance) header++;

    let footer = 0;
    while (header + footer < h && rowDistance(base, cur, h - 1 - footer) <= o.stickyTolerance) footer++;

    const cap = Math.floor(h * o.maxStickyPct);
    return { header: Math.min(header, cap), footer: Math.min(footer, cap) };
}

// Incremental stitcher. Feed it frames; it tells you which rows to keep.
//
// Decisions:
//   'need-more' — first frame, nothing to compare against yet
//   'idle'      — matched, but the content hasn't moved far enough to commit
//   'append'    — take `add` rows from THIS frame (plus `base` rows from the previous
//                 frame on the very first commit)
//   'reject'    — no confident match; the base is held so the capture can recover
//   'full'      — the output cap was reached; stop capturing
//
// The base frame advances ONLY on a commit. Holding it means a slow crawl accumulates into
// a measurable offset instead of reading as a permanent standstill, and a too-fast flick
// can still re-match once the user scrolls back into range.
export function createStitcher(opts = {}) {
    const o = { ...DEFAULTS, ...opts };

    let baseProfile = null;
    let width = 0;            // width of the frames being pushed
    let outWidth = 0;         // width of the image the caller is building — what the cap sees
    let frameHeight = 0;
    let committedRows = 0;
    let commits = 0;
    let started = false;             // has anything been written to the output yet?
    let lastOffset = 0;              // scroll velocity hint for the ambiguity tie-break
    let sticky = { header: 0, footer: 0 };
    let stickyKnown = false;
    let gaps = 0;                    // rejections after the capture started = possible loss

    const contentBottom = () => frameHeight - sticky.footer;

    // Conservative middle band until sticky chrome has been measured: chrome sits at the
    // very edges, so the middle is clean even when we don't yet know how deep it goes.
    function matchBand() {
        if (!stickyKnown) {
            return {
                top: Math.floor(frameHeight * 0.15),
                bottom: Math.ceil(frameHeight * 0.85)
            };
        }
        return { top: sticky.header, bottom: contentBottom() };
    }

    function remainingRows() {
        const byHeight = o.maxHeight - committedRows;
        const byPixels = outWidth ? Math.floor(o.maxPixels / outWidth) - committedRows : byHeight;
        return Math.max(0, Math.min(byHeight, byPixels));
    }

    function push(frame) {
        const profile = buildProfile(frame, o);

        if (!baseProfile) {
            width = frame.width;
            outWidth = o.outputWidth || frame.width;
            frameHeight = frame.height;
            baseProfile = profile;
            return { status: 'need-more', offset: 0, score: 0, base: null, add: null, sticky, reason: null };
        }
        if (frame.width !== width || frame.height !== frameHeight) {
            // The region is fixed for the lifetime of a capture; a size change means the
            // caller handed us frames from two different crops.
            return { status: 'reject', offset: 0, score: Infinity, base: null, add: null, sticky, reason: 'size-changed' };
        }

        const { candidates, reason } = findOffset(baseProfile, profile, matchBand(), o);
        if (!candidates.length) {
            return { status: 'reject', offset: 0, score: Infinity, base: null, add: null, sticky, reason: reason || 'no-candidates' };
        }

        const best = candidates[0];
        const runnerUp = candidates[1];

        if (best.score > o.acceptScore) {
            if (started) gaps++;
            return { status: 'reject', offset: 0, score: best.score, base: null, add: null, sticky, reason: 'no-match' };
        }

        // Several offsets fit about as well — repetitive content. Scrolling is continuous,
        // so the offset near the last committed one is the honest reading; with no history
        // to lean on, refuse rather than guess.
        let chosen = best;
        if (runnerUp && best.score >= runnerUp.score * o.ambiguityRatio) {
            const viable = candidates.filter(c => c.score <= o.acceptScore);
            const near = lastOffset
                ? viable.filter(c => Math.abs(c.offset - lastOffset) <= o.hintTolerance)
                : [];
            if (near.length !== 1) {
                if (started) gaps++;
                return { status: 'reject', offset: best.offset, score: best.score, base: null, add: null, sticky, reason: 'ambiguous' };
            }
            chosen = near[0];
        }

        // Sticky chrome is re-measured for the first few commits and then frozen: the
        // estimate only ever grows, and letting it grow forever would eventually eat real
        // content on a page whose body happens to hold still for a moment.
        if (chosen.offset >= o.stickyMinScroll && commits <= o.stickyFreezeAfter) {
            const m = measureStatic(baseProfile, profile, o);
            sticky = {
                header: Math.max(sticky.header, m.header),
                footer: Math.max(sticky.footer, m.footer)
            };
            stickyKnown = true;
        }

        // Not enough motion to commit. Hold the base so the offset keeps accumulating.
        // Committing before sticky chrome is known would bake a footer into the seam, so a
        // first match that barely moved waits too.
        if (chosen.offset < o.minScroll || (!started && !stickyKnown)) {
            return { status: 'idle', offset: chosen.offset, score: chosen.score, base: null, add: null, sticky, reason: null };
        }

        const bottom = contentBottom();
        // Rows below `bottom - offset` had no counterpart in the base frame: that is exactly
        // the new content, and nothing above it may be re-appended.
        let addTop = bottom - chosen.offset;
        let addHeight = chosen.offset;
        let baseRange = null;

        if (!started) {
            // First commit also lays down the base frame — everything above the sticky
            // footer, header included. It has been held until now precisely so that this
            // happens with the footer already known.
            baseRange = { top: 0, height: bottom };
        }

        let room = remainingRows();
        let full = false;

        if (baseRange) {
            if (baseRange.height >= room) {
                baseRange.height = room;
                full = true;
            }
            room -= baseRange.height;
        }
        if (addHeight > room) {
            // Keep the BOTTOM of the new strip: it is the content closest to where the user
            // is looking, and clipping the top only re-loses rows the next frame would
            // have carried anyway.
            addTop += addHeight - room;
            addHeight = room;
            full = true;
        }

        committedRows += (baseRange ? baseRange.height : 0) + addHeight;
        commits++;
        started = true;
        lastOffset = chosen.offset;
        baseProfile = profile;

        return {
            status: full ? 'full' : 'append',
            offset: chosen.offset,
            score: chosen.score,
            base: baseRange,
            add: addHeight > 0 ? { top: addTop, height: addHeight } : null,
            sticky,
            reason: null
        };
    }

    return {
        push,
        get width() { return outWidth; },
        get height() { return committedRows; },
        get commits() { return commits; },
        get sticky() { return sticky; },
        get gaps() { return gaps; },
        get started() { return started; },
        // Sticky footer of the LAST frame, appended once at the very end so a page with a
        // pinned toolbar still ends on it instead of cutting away mid-content.
        get footerHeight() { return sticky.footer; },
        get remainingRows() { return remainingRows(); }
    };
}
