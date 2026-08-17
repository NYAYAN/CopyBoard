// Unit tests for the scroll-capture stitcher.
//
// Run with:  npm test
//
// The property under test is that the rows the stitcher hands back, concatenated in the
// order it hands them back, reproduce the underlying page EXACTLY ONCE and IN ORDER — no
// duplicated strips, no skipped bands, no sticky chrome smeared through the middle. Every
// scenario below therefore replays synthetic frames and then checks the reconstructed page
// row sequence, which is a far stronger assertion than checking the detected offsets.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// The app ships as "type": "commonjs", so Node would parse this ESM source as CJS and choke
// on `export`. Loading it through a data: URL forces ESM parsing without adding a nested
// package.json to the packaged app — same trick as accelerator.test.mjs. stitcher.js has no
// relative imports, which is what makes this the real module rather than a stand-in.
const MODULE_PATH = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '../src/renderer/scroller/stitcher.js'
);
const source = await readFile(MODULE_PATH, 'utf8');
const { createStitcher, buildProfile, findOffset, measureStatic, DEFAULTS } =
    await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

// ── Synthetic pages ────────────────────────────────────────────────────────────
// Deterministic PRNG so a failure is reproducible.
function mulberry32(seed) {
    let a = seed;
    return () => {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// A tall "page". `detail` scales how much rows differ from each other: 1 is busy content,
// 0.05 is a near-uniform wall where every offset matches about as well as any other.
function makePage(width, height, { seed = 1, detail = 1 } = {}) {
    const rnd = mulberry32(seed);
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        // One base tone per row plus per-pixel texture, so rows are distinguishable both
        // from their neighbours and from far-away rows.
        const tone = 128 + Math.floor((rnd() - 0.5) * 220 * detail);
        for (let x = 0; x < width; x++) {
            const p = (y * width + x) * 4;
            const v = Math.max(0, Math.min(255, tone + Math.floor((rnd() - 0.5) * 200 * detail)));
            data[p] = data[p + 1] = data[p + 2] = v;
            data[p + 3] = 255;
        }
    }
    return { width, height, data };
}

// A page whose rows repeat with a fixed period — a table or list, the classic case where
// several offsets score identically.
function makeRepeatingPage(width, height, period, { seed = 7 } = {}) {
    const tile = makePage(width, period, { seed });
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        const src = (y % period) * width * 4;
        data.set(tile.data.subarray(src, src + width * 4), y * width * 4);
    }
    return { width, height, data };
}

// A solid band, used for sticky chrome.
function bandRow(width, value) {
    const row = new Uint8ClampedArray(width * 4);
    for (let x = 0; x < width; x++) {
        const p = x * 4;
        row[p] = row[p + 1] = row[p + 2] = value;
        row[p + 3] = 255;
    }
    return row;
}

// One frame of the capture region: page rows [scrollY, scrollY + height), with sticky
// chrome painted OVER the top and bottom the way a real pinned toolbar sits above content.
function viewport(page, scrollY, height, { header = 0, footer = 0 } = {}) {
    const { width } = page;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        const src = Math.min(page.height - 1, scrollY + y) * width * 4;
        data.set(page.data.subarray(src, src + width * 4), y * width * 4);
    }
    for (let y = 0; y < header; y++) data.set(bandRow(width, 40 + y), y * width * 4);
    for (let y = 0; y < footer; y++) {
        data.set(bandRow(width, 200 - y), (height - 1 - y) * width * 4);
    }
    return { width, height, data };
}

// ── Replay harness ─────────────────────────────────────────────────────────────
// Feeds a scroll sequence through the stitcher and records, for every row it accepted,
// which PAGE row that was — the ground truth the assertions are written against.
function replay(page, scrolls, frameHeight, chrome = {}, opts = {}) {
    const stitcher = createStitcher(opts);
    const header = chrome.header || 0;
    const footer = chrome.footer || 0;
    const rows = [];          // page row index per output row; null = sticky chrome
    const statuses = [];
    let prevScroll = null;

    for (const scrollY of scrolls) {
        const frame = viewport(page, scrollY, frameHeight, chrome);
        const d = stitcher.push(frame);
        statuses.push(d.status);

        // `base` rows come from the PREVIOUS frame, which is why the caller has to keep it.
        if (d.base) {
            for (let y = d.base.top; y < d.base.top + d.base.height; y++) {
                rows.push(y < header ? null : prevScroll + y);
            }
        }
        if (d.add) {
            for (let y = d.add.top; y < d.add.top + d.add.height; y++) {
                rows.push(y < header ? null : scrollY + y);
            }
        }
        if (d.base || d.add) prevScroll = scrollY;
        else if (prevScroll === null) prevScroll = scrollY;
        if (d.status === 'full') break;
    }
    return { stitcher, rows, statuses, header, footer };
}

// The content rows must be strictly consecutive: any repeat is a duplicated strip, any jump
// is content the capture lost.
function assertContiguous(rows, label) {
    const content = rows.filter(r => r !== null);
    assert.ok(content.length > 0, `${label}: nothing was captured`);
    for (let i = 1; i < content.length; i++) {
        assert.equal(
            content[i], content[i - 1] + 1,
            `${label}: page rows jumped from ${content[i - 1]} to ${content[i]} at output row ${i}`
        );
    }
    return content;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

test('buildProfile reduces each row to one luma sample per column', () => {
    const frame = makePage(200, 10);
    const p = buildProfile(frame);
    assert.equal(p.height, 10);
    assert.equal(p.cols, DEFAULTS.sampleCols);
    assert.equal(p.data.length, 10 * DEFAULTS.sampleCols);
});

test('buildProfile falls back to one sample per column on a narrow region', () => {
    // 20px wide leaves fewer usable columns than sampleCols once the edges are excluded.
    const p = buildProfile(makePage(20, 5));
    assert.ok(p.cols > 0 && p.cols <= 20, `unexpected column count ${p.cols}`);
    assert.equal(p.data.length, 5 * p.cols);
});

test('findOffset recovers a known scroll distance', () => {
    const page = makePage(300, 1200);
    const a = buildProfile(viewport(page, 100, 400));
    const b = buildProfile(viewport(page, 137, 400));
    const { candidates } = findOffset(a, b, { top: 0, bottom: 400 });
    assert.equal(candidates[0].offset, 37);
    assert.ok(candidates[0].score < DEFAULTS.acceptScore, `score ${candidates[0].score} too high`);
});

test('a phantom far offset does not beat the true one on periodic content', () => {
    // Regression. Scores are means, so a 450px offset is judged on the ~50 rows that still
    // overlap while the true 50px offset is judged on ~450. Where the tail of the region is
    // periodic, those few rows agree perfectly and the phantom used to win outright — the
    // stitcher then appended 450 rows of already-captured content and tore a hole in the
    // page. The overlap penalty is what keeps the honest reading on top.
    const page = makePage(300, 3000, { seed: 3 });
    const tile = makePage(300, 40, { seed: 11 });
    for (let y = 1200; y < 3000; y++) {
        const src = ((y - 1200) % 40) * 300 * 4;
        page.data.set(tile.data.subarray(src, src + 300 * 4), y * 300 * 4);
    }

    const base = buildProfile(viewport(page, 1150, 500));
    const cur = buildProfile(viewport(page, 1200, 500));
    const { candidates } = findOffset(base, cur, { top: 0, bottom: 500 });

    assert.equal(candidates[0].offset, 50, `ranked ${candidates.map(c => c.offset).join(', ')}`);
    assert.equal(candidates[0].score, 0, 'the true offset is an exact match');
});

test('measureStatic finds sticky chrome and ignores the moving body', () => {
    const page = makePage(300, 1200);
    const chrome = { header: 50, footer: 30 };
    const a = buildProfile(viewport(page, 100, 400, chrome));
    const b = buildProfile(viewport(page, 160, 400, chrome));
    const s = measureStatic(a, b);
    // The bands themselves are static; the first moving row may also happen to match, so
    // allow a little slack upward but never less than the real chrome.
    assert.ok(s.header >= 50 && s.header <= 60, `header ${s.header}`);
    assert.ok(s.footer >= 30 && s.footer <= 40, `footer ${s.footer}`);
});

test('a plain scroll stitches into one contiguous run of page rows', () => {
    const page = makePage(400, 4000);
    const frameH = 600;
    const scrolls = [];
    for (let y = 0; y <= 2400; y += 60) scrolls.push(y);

    const { rows, stitcher } = replay(page, scrolls, frameH);
    const content = assertContiguous(rows, 'plain scroll');

    assert.equal(content[0], 0, 'capture should begin at the first visible page row');
    assert.equal(content[content.length - 1], 2400 + frameH - 1, 'capture should reach the last visible row');
    assert.equal(stitcher.height, rows.length);
    assert.equal(stitcher.gaps, 0);
});

test('sticky header and footer appear once and never inside the content', () => {
    const page = makePage(400, 4000);
    const frameH = 600;
    const chrome = { header: 60, footer: 40 };
    const scrolls = [];
    for (let y = 0; y <= 1800; y += 70) scrolls.push(y);

    const { rows, stitcher } = replay(page, scrolls, frameH, chrome);

    // Chrome rows are the leading run and nothing else: a sticky band that leaked into the
    // body would show up as a null in the middle of the sequence.
    const firstContent = rows.findIndex(r => r !== null);
    assert.ok(firstContent > 0, 'the header should lead the output');
    assert.ok(rows.slice(firstContent).every(r => r !== null), 'sticky chrome leaked into the content');

    assert.ok(stitcher.sticky.header >= 60, `header underestimated: ${stitcher.sticky.header}`);
    assert.ok(stitcher.sticky.footer >= 40, `footer underestimated: ${stitcher.sticky.footer}`);
    assertContiguous(rows, 'sticky chrome');
});

test('a still screen never commits anything', () => {
    const page = makePage(300, 1500);
    const { rows, statuses, stitcher } = replay(page, [200, 200, 200, 200], 500);
    assert.equal(rows.length, 0);
    assert.equal(stitcher.started, false);
    assert.deepEqual(statuses, ['need-more', 'idle', 'idle', 'idle']);
});

test('a crawl too slow to commit accumulates instead of stalling', () => {
    // 2px a frame is below minScroll. Holding the base is what lets four of those add up
    // into one committable 8px step; advancing it each time would read as a standstill
    // forever and the capture would never start.
    const page = makePage(300, 1500);
    const { rows, stitcher } = replay(page, [100, 102, 104, 106, 108, 110, 112], 500);
    assert.ok(stitcher.started, 'the capture should eventually start');
    assertContiguous(rows, 'slow crawl');
});

test('repetitive content is refused rather than guessed at', () => {
    // Every offset that is a multiple of the period matches perfectly, so there is no
    // honest answer from a standing start.
    const page = makeRepeatingPage(300, 2000, 40);
    const a = buildProfile(viewport(page, 0, 500));
    const b = buildProfile(viewport(page, 80, 500));

    const stitcher = createStitcher();
    stitcher.push(viewport(page, 0, 500));
    const d = stitcher.push(viewport(page, 80, 500));

    assert.equal(d.status, 'reject');
    assert.equal(d.reason, 'ambiguous');
    assert.equal(stitcher.started, false);

    // Sanity: the ambiguity is real, not an artefact of the harness.
    const { candidates } = findOffset(a, b, { top: 0, bottom: 500 });
    assert.ok(candidates.length > 1);
    assert.ok(candidates[1].score <= DEFAULTS.acceptScore, 'the runner-up should be just as good');
});

test('scroll velocity carries the capture through a repetitive stretch', () => {
    // Distinctive content first, so the stitcher learns a scroll rate, then a table whose
    // rows repeat every 40px. Offsets 40 apart score identically there; the only thing that
    // separates them is that scrolling is continuous, and 50 is what the user has been
    // doing all along.
    const page = makePage(300, 3000, { seed: 3 });
    const tile = makePage(300, 40, { seed: 11 });
    for (let y = 1200; y < 3000; y++) {
        const src = ((y - 1200) % 40) * 300 * 4;
        page.data.set(tile.data.subarray(src, src + 300 * 4), y * 300 * 4);
    }

    const scrolls = [];
    for (let y = 0; y <= 2000; y += 50) scrolls.push(y);
    const { rows, stitcher } = replay(page, scrolls, 500);

    const content = assertContiguous(rows, 'repetitive stretch');
    assert.ok(
        content[content.length - 1] > 1400,
        `capture stalled at page row ${content[content.length - 1]} instead of crossing into the table`
    );
    assert.equal(stitcher.gaps, 0, 'the velocity hint should have resolved every frame');
});

test('a frame is matched well inside the sampling budget', () => {
    // A guard against algorithmic regressions, not a benchmark: sampling at ~20fps leaves
    // 50ms a frame, and everything else in the loop (crop, drawImage) has to fit too. The
    // bound is loose enough for a slow machine but would catch a full-resolution sweep
    // sneaking back into the coarse pass.
    const page = makePage(1200, 4000, { seed: 5 });
    const stitcher = createStitcher();
    stitcher.push(viewport(page, 0, 800));

    const frames = [];
    for (let i = 1; i <= 10; i++) frames.push(viewport(page, i * 60, 800));

    const started = process.hrtime.bigint();
    for (const f of frames) stitcher.push(f);
    const msPerFrame = Number(process.hrtime.bigint() - started) / 1e6 / frames.length;

    assert.ok(msPerFrame < 25, `push() took ${msPerFrame.toFixed(1)}ms a frame`);
});

test('scrolling past the region is rejected, and the capture recovers afterwards', () => {
    const page = makePage(400, 6000);
    const frameH = 500;
    // Steady scroll, one enormous flick that leaves no overlap at all, then steady again
    // from where the flick landed.
    const scrolls = [0, 60, 120, 180, 3000, 3060, 3120, 3180];

    const { rows, statuses, stitcher } = replay(page, scrolls, frameH);

    assert.ok(statuses.includes('reject'), 'the flick should be rejected, not spliced');
    assert.ok(stitcher.gaps >= 1, 'a rejection after the start must be counted as a possible gap');

    // Everything committed is still contiguous — the flick cost content, but the stitcher
    // reported it instead of welding two unrelated bands together.
    const content = rows.filter(r => r !== null);
    const jumps = content.filter((r, i) => i > 0 && r !== content[i - 1] + 1);
    assert.equal(jumps.length, 0, 'a gap was silently spliced into the output');
    assert.ok(content[content.length - 1] < 3000 + frameH, 'content past the flick should not be welded on');
});

test('the output cap stops the capture instead of growing without bound', () => {
    const page = makePage(200, 20000);
    const frameH = 400;
    const scrolls = [];
    for (let y = 0; y <= 8000; y += 100) scrolls.push(y);

    // 200px wide x 1200 rows.
    const { rows, statuses, stitcher } = replay(page, scrolls, frameH, {}, { maxPixels: 200 * 1200 });

    assert.ok(statuses.includes('full'), 'the cap should surface as a full status');
    assert.equal(stitcher.height, 1200);
    assert.equal(rows.length, 1200);
    assertContiguous(rows, 'capped output');
});

test('a region shorter than the minimum overlap is refused, not mis-stitched', () => {
    const page = makePage(300, 800);
    const stitcher = createStitcher();
    stitcher.push(viewport(page, 0, 40));
    const d = stitcher.push(viewport(page, 10, 40));
    assert.equal(d.status, 'reject');
    assert.equal(d.reason, 'band-too-short');
});
