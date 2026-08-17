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
    // No re-measuring after the capture starts: the strip is bookkept in units of the moving
    // band, so revising the band's height mid-capture would displace everything already in it.

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
//
// The offset is SIGNED: positive means the content moved up the screen (the user scrolled
// down the page), negative means it moved down (scrolled up). Both rows have to stay inside
// the band, which is what the two clamps below express — for a negative offset the usable
// range starts further down instead of ending further up.
function bandScore(base, cur, offset, top, bottom, rowStep, colStep) {
    const s = cur.cols;
    const a = cur.data, b = base.data;
    const yStart = offset < 0 ? top - offset : top;
    const yEnd = offset < 0 ? bottom : bottom - offset;
    let sum = 0, count = 0;

    for (let y = yStart; y < yEnd; y += rowStep) {
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

    const prior = (d) => o.overlapPenalty * (Math.abs(d) / bandRows);

    const step = o.coarseRowStep;
    const cTop = Math.ceil(top / step);
    const cBottom = Math.floor(bottom / step);
    const cMax = Math.floor(maxShift / step);

    // Both directions: scrolling UP is a negative offset, and searching only the positive
    // half is what made an upward capture match nothing at all.
    const coarse = [];
    for (let dc = -cMax; dc <= cMax; dc++) {
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
        const lo = Math.max(-maxShift, seed - step);
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

// Incremental stitcher. Feed it frames; it tells you which rows to keep and at which end.
//
// The captured page is tracked as an INTERVAL in absolute page coordinates rather than as a
// pile of rows growing downward. That is what makes direction fall out for free: whichever
// end of the interval a new frame sticks out of is the end its new rows belong to. Scrolling
// down extends the bottom, scrolling up extends the top, and scrolling back over ground
// already captured adds nothing at all. The origin is arbitrary — it is the content top of
// the first committed frame.
//
// Decisions:
//   'need-more' — first frame, nothing to compare against yet
//   'idle'      — matched, but the content hasn't moved far enough to commit
//   'seen'      — moved, and every row of it is already captured (scrolled back over)
//   'append'    — take `add.height` rows from THIS frame starting at `add.top`, and put them
//                 at `add.side` ('bottom' or 'top') of what you have. On the very first
//                 commit `base` additionally gives the rows to seed the strip with, taken
//                 from the PREVIOUS frame.
//   'reject'    — no confident match; the base is held so the capture can recover
//   'full'      — the output cap was reached; stop capturing
//
// Sticky chrome is NOT part of the strip. The caller places the header above it and the
// footer below it once, when composing — see headerHeight/footerHeight. Baking the header
// into the strip would strand it in the middle of the image the moment anything is
// prepended above it.
//
// The base frame advances on a commit or a 'seen'. It is HELD on idle and reject: holding
// means a crawl too slow to commit accumulates into a measurable offset instead of reading
// as a permanent standstill, and a flick too fast to match can still re-match once the user
// scrolls back into range.
export function createStitcher(opts = {}) {
    const o = { ...DEFAULTS, ...opts };

    let baseProfile = null;
    let width = 0;            // width of the frames being pushed
    let outWidth = 0;         // width of the image the caller is building — what the cap sees
    let frameHeight = 0;
    let commits = 0;
    let started = false;             // has anything been written to the output yet?
    let lastOffset = 0;              // scroll velocity hint for the ambiguity tie-break
    let sticky = { header: 0, footer: 0 };
    let stickyKnown = false;
    let gaps = 0;                    // rejections after the capture started = possible loss

    // Absolute coordinates. `pos` is where the CURRENT base frame's content top sits;
    // [capLo, capHi) is everything captured so far.
    let pos = 0;
    let capLo = 0;
    let capHi = 0;

    const contentTop = () => sticky.header;
    const contentBottom = () => frameHeight - sticky.footer;
    const bandHeight = () => contentBottom() - contentTop();
    const chromeRows = () => sticky.header + sticky.footer;
    const capturedRows = () => capHi - capLo;

    // Conservative middle band until sticky chrome has been measured: chrome sits at the
    // very edges, so the middle is clean even when we don't yet know how deep it goes.
    function matchBand() {
        if (!stickyKnown) {
            return {
                top: Math.floor(frameHeight * 0.15),
                bottom: Math.ceil(frameHeight * 0.85)
            };
        }
        return { top: contentTop(), bottom: contentBottom() };
    }

    // Chrome is counted against the budget because the caller adds it to the final image.
    function remainingRows() {
        const used = capturedRows() + chromeRows();
        const byHeight = o.maxHeight - used;
        const byPixels = outWidth ? Math.floor(o.maxPixels / outWidth) - used : byHeight;
        return Math.max(0, Math.min(byHeight, byPixels));
    }

    const decide = (status, extra = {}) => ({
        status, offset: 0, score: Infinity, base: null, add: null, reason: null,
        sticky, ...extra
    });

    function push(frame) {
        const profile = buildProfile(frame, o);

        if (!baseProfile) {
            width = frame.width;
            outWidth = o.outputWidth || frame.width;
            frameHeight = frame.height;
            baseProfile = profile;
            return decide('need-more', { offset: 0, score: 0 });
        }
        if (frame.width !== width || frame.height !== frameHeight) {
            // The region is fixed for the lifetime of a capture; a size change means the
            // caller handed us frames from two different crops.
            return decide('reject', { reason: 'size-changed' });
        }

        const { candidates, reason } = findOffset(baseProfile, profile, matchBand(), o);
        if (!candidates.length) return decide('reject', { reason: reason || 'no-candidates' });

        const best = candidates[0];
        const runnerUp = candidates[1];

        if (best.score > o.acceptScore) {
            if (started) gaps++;
            return decide('reject', { score: best.score, reason: 'no-match' });
        }

        // Several offsets fit about as well — repetitive content. Scrolling is continuous, so
        // the offset near the last committed one is the honest reading (its SIGN included,
        // which is most of what rules out a mirror-image match); with no history to lean on,
        // refuse rather than guess.
        let chosen = best;
        if (runnerUp && best.score >= runnerUp.score * o.ambiguityRatio) {
            const viable = candidates.filter(c => c.score <= o.acceptScore);
            const near = lastOffset
                ? viable.filter(c => Math.abs(c.offset - lastOffset) <= o.hintTolerance)
                : [];
            if (near.length !== 1) {
                if (started) gaps++;
                return decide('reject', { offset: best.offset, score: best.score, reason: 'ambiguous' });
            }
            chosen = near[0];
        }

        const magnitude = Math.abs(chosen.offset);

        // Sticky chrome is measured once, on the frame that starts the capture, and then
        // frozen. Everything below counts in units of the moving band, so a band that
        // changed height mid-capture would silently displace every row committed after it.
        if (!started && magnitude >= o.stickyMinScroll) {
            sticky = measureStatic(baseProfile, profile, o);
            stickyKnown = true;
        }

        // Not enough motion to commit — hold the base so the offset keeps accumulating.
        // Committing before sticky chrome is known would fix the strip's geometry to a band
        // we have not measured yet, so a first match that barely moved waits too.
        if (magnitude < o.minScroll || (!started && !stickyKnown)) {
            return decide('idle', { offset: chosen.offset, score: chosen.score });
        }

        const cTop = contentTop();
        const H = bandHeight();
        let room = remainingRows();
        let full = false;
        let baseRange = null;

        if (!started) {
            // Seed the strip with the base frame's whole moving band.
            const take = Math.min(H, room);
            if (take < H) full = true;
            baseRange = { top: cTop, height: take };
            pos = 0;
            capLo = 0;
            capHi = take;
            room -= take;
        }

        const newPos = pos + chosen.offset;
        let add = null;

        // A frame is the width of the band, and after the seed the interval is at least that
        // wide, so it can stick out of AT MOST one end.
        if (newPos + H > capHi) {
            const gain = (newPos + H) - capHi;
            const take = Math.min(gain, room);
            if (take < gain) full = true;
            if (take > 0) {
                // Rows adjacent to the strip come first, so a clamped take drops from the far
                // end and what is kept still joins on cleanly.
                add = { top: cTop + (capHi - newPos), height: take, side: 'bottom' };
                capHi += take;
                room -= take;
            }
        } else if (newPos < capLo) {
            const gain = capLo - newPos;
            const take = Math.min(gain, room);
            if (take < gain) full = true;
            if (take > 0) {
                // Prepending, so the rows adjacent to the strip are at the BOTTOM of the new
                // range — those are the ones to keep.
                add = { top: cTop + (capLo - newPos) - take, height: take, side: 'top' };
                capLo -= take;
                room -= take;
            }
        }

        pos = newPos;
        baseProfile = profile;
        lastOffset = chosen.offset;

        if (!baseRange && !add) {
            // No new rows, for one of two very different reasons: the frame stayed inside
            // ground already captured ('seen' — the base still advances, because we know
            // where we are), or there WAS new content and the cap left no room for it, which
            // has to surface as 'full' or the caller would never learn to stop.
            return decide(full ? 'full' : 'seen', { offset: chosen.offset, score: chosen.score });
        }

        commits++;
        started = true;
        return decide(full ? 'full' : 'append', {
            offset: chosen.offset,
            score: chosen.score,
            base: baseRange,
            add
        });
    }

    return {
        push,
        get width() { return outWidth; },
        // Rows in the strip. The composed image is this plus headerHeight + footerHeight.
        get height() { return capturedRows(); },
        get commits() { return commits; },
        get sticky() { return sticky; },
        get gaps() { return gaps; },
        get started() { return started; },
        // Sticky chrome, placed once by the caller: the header above the strip and the footer
        // below it, so a page with pinned bars still begins and ends on them. Any frame will
        // do as the source — chrome is by definition the part that did not change.
        get headerHeight() { return sticky.header; },
        get footerHeight() { return sticky.footer; },
        get remainingRows() { return remainingRows(); }
    };
}
