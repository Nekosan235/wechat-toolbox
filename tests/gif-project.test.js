const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { GifProject, MAX_BYTES } = require('../utils/gif-project');
const { GifEncoder } = require('../utils/gif-encoder');
const { parseGif, composeGifFrames } = require('../utils/gif-decoder');

const WHITE = [255, 255, 255, 255];
const RED = [255, 0, 0, 255];
const BLUE = [0, 0, 255, 255];
const GREEN = [0, 255, 0, 255];
const GREY = [185, 185, 185, 255];
const CLEAR = [0, 0, 0, 0];
const row = colours => Uint8ClampedArray.from(colours.flat());
const pixel = (data, index) => Array.from(data.slice(index * 4, index * 4 + 4));
const stroke = (tool, x, y = 0.5) => ({ tool, radius: 1, points: [{ x, y }] });

function gifBytes(frames, options = {}) {
  const width = options.width || frames[0].data.length / 4;
  const encoder = new GifEncoder(width, options.height || 1, { loopCount: options.loopCount ?? null });
  for (const frame of frames) encoder.addFrame(frame.data, frame.delay ?? 10);
  return encoder.finish();
}

function project(frames, options) {
  return new GifProject(gifBytes(frames, options));
}

function editFixture() {
  return project([
    { data: row([WHITE, RED, BLUE, GREY, GREEN, RED, WHITE]), delay: 0 },
    { data: row([WHITE, BLUE, RED, GREY, RED, GREEN, WHITE]), delay: 7 },
    { data: row([WHITE, GREEN, BLUE, GREY, RED, BLUE, WHITE]), delay: 31 }
  ], { loopCount: 4 });
}

test('edits and undo are independent per frame; original pixels remain unchanged', () => {
  const p = editFixture();
  const original = p.original(0).slice();
  const secondBefore = p.render(1);
  p.addStroke(0, stroke('erase', 4.5));
  p.addStroke(1, stroke('restore', 0.5));
  assert.equal(p.editedCount, 2);
  assert.equal(pixel(p.render(0), 4)[3], 0);
  assert.deepEqual(pixel(p.render(1), 0), WHITE);
  assert.deepEqual(p.original(0), original);
  assert.equal(p.undo(0).tool, 'erase');
  assert.equal(p.editedCount, 1);
  assert.deepEqual(pixel(p.render(0), 4), GREEN);
  assert.deepEqual(pixel(p.render(1), 0), WHITE);
  assert.equal(p.undo(0), undefined);
  p.undo(1);
  assert.deepEqual(p.render(1), secondBefore);
});

test('restore uses original RGBA, rather than auto-processed or already erased pixels', () => {
  const p = project([{ data: row([WHITE, RED, CLEAR, BLUE, WHITE]) }]);
  assert.equal(pixel(p.render(0), 0)[3], 0);
  p.addStroke(0, stroke('erase', 0.5));
  p.addStroke(0, stroke('restore', 0.5));
  assert.deepEqual(pixel(p.render(0), 0), WHITE);
  p.addStroke(0, stroke('restore', 2.5));
  assert.deepEqual(pixel(p.render(0), 2), CLEAR);
  assert.deepEqual(pixel(p.render(0), 3), BLUE);
});

test('changing automatic settings recomputes pixels and then replays recorded brush edits', () => {
  const p = project([{ data: row([WHITE, RED, BLUE, GREY, RED, GREEN, BLUE, RED, WHITE]) }]);
  p.addStroke(0, stroke('restore', 0.5));
  p.addStroke(0, stroke('erase', 5.5));
  assert.deepEqual(pixel(p.render(0), 3), GREY);
  p.settings = { tolerance: 80, feather: 0, mode: 'all' };
  const edited = p.render(0);
  assert.deepEqual(pixel(edited, 0), WHITE);
  assert.equal(pixel(edited, 3)[3], 0);
  assert.equal(pixel(edited, 5)[3], 0);
  p.settings = { tolerance: 0, feather: 0, mode: 'edge' };
  assert.deepEqual(pixel(p.render(0), 0), WHITE);
  assert.deepEqual(pixel(p.render(0), 3), GREY);
  assert.equal(pixel(p.render(0), 5)[3], 0);
  assert.equal(p.strokes[0].length, 2);
});

test('input stroke objects are copied, so later UI mutation cannot alter recorded edits', () => {
  const p = editFixture();
  const input = stroke('erase', 4.5);
  p.addStroke(0, input);
  const before = p.render(0);
  input.tool = 'restore';
  input.radius = 40;
  input.points[0].x = 0;
  assert.deepEqual(p.render(0), before);
});

test('random seek preserves original frames with an LRU cache of at most three', () => {
  const originals = [RED, BLUE, GREEN, GREY, WHITE, RED].map(colour => row([colour]));
  const p = project(originals.map(data => ({ data })));
  for (const index of [0, 1, 2, 0, 3, 5, 1, 4, 0, 5, 2]) {
    assert.deepEqual(p.original(index), originals[index]);
    assert.ok(p.cache.size <= 3);
    assert.equal(Array.from(p.cache.keys()).at(-1), index);
  }
  const q = project(originals.map(data => ({ data })));
  q.original(0); q.original(1); q.original(2); q.original(0); q.original(3);
  assert.deepEqual(Array.from(q.cache.keys()), [2, 0, 3]);
  assert.ok(!q.cache.has(1));
});

test('export preserves original delays including zero, loop count and frame-specific edits', async () => {
  const p = editFixture();
  p.addStroke(0, stroke('restore', 0.5));
  p.addStroke(1, stroke('erase', 3.5));
  const progress = [];
  let yields = 0;
  const output = await p.encode({
    progress: (done, total) => progress.push([done, total]),
    yieldFrame: async () => { yields++; }
  });
  const parsed = parseGif(output);
  assert.equal(parsed.loopCount, 4);
  assert.deepEqual(parsed.frames.map(frame => frame.delay), [0, 7, 31]);
  assert.deepEqual(progress, [[1, 3], [2, 3], [3, 3]]);
  assert.equal(yields, 3);
  const decoded = [...composeGifFrames(parsed)];
  assert.deepEqual(pixel(decoded[0].data, 0), WHITE);
  assert.equal(pixel(decoded[1].data, 3)[3], 0);
  assert.deepEqual(pixel(decoded[2].data, 3), GREY);
  for (let index = 0; index < decoded.length; index++) {
    const expected = p.render(index);
    for (let offset = 0; offset < expected.length; offset += 4) {
      assert.equal(decoded[index].data[offset + 3], expected[offset + 3]);
      if (expected[offset + 3]) {
        assert.deepEqual(Array.from(decoded[index].data.slice(offset, offset + 4)), Array.from(expected.slice(offset, offset + 4)));
      }
    }
  }
});

test('non-looping and infinite-loop exports retain their distinct metadata', async () => {
  for (const loopCount of [null, 0]) {
    const p = project([{ data: row([RED]) }], { loopCount });
    assert.equal(parseGif(await p.encode()).loopCount, loopCount);
  }
});

test('cancellation before, during and after final frame rejects without returning an artifact', async () => {
  for (const cancelAfter of [0, 1, 3]) {
    const p = editFixture();
    let done = 0;
    let artifact;
    await assert.rejects(async () => {
      artifact = await p.encode({ cancelled: () => done >= cancelAfter, progress: count => { done = count; } });
    }, /取消/);
    assert.equal(artifact, undefined);
    assert.equal(done, cancelAfter);
    // Cancellation does not corrupt the project or prevent a fresh export.
    assert.equal(parseGif(await p.encode()).frameCount, 3);
  }
});

test('resizes large GIF previews and exports to at most 480 pixels on the longest side', async () => {
  const source = row(Array.from({ length: 960 }, (_, index) => index < 480 ? RED : BLUE));
  const p = project([{ data: source }]);
  assert.equal(p.width, 480);
  assert.equal(p.height, 1);
  assert.deepEqual(pixel(p.original(0), 0), RED);
  assert.deepEqual(pixel(p.original(0), 479), BLUE);
  const parsed = parseGif(await p.encode());
  assert.equal(parsed.width, 480);
  assert.equal(parsed.height, 1);
});

test('rejects oversized files, parser limits and excessive aggregate canvas pixels', () => {
  assert.throws(() => new GifProject(new Uint8Array(MAX_BYTES + 1)), /8 MB/);
  assert.throws(() => new GifProject(null), /8 MB/);
  assert.throws(() => project(Array.from({ length: 61 }, () => ({ data: row([RED]), delay: 1 }))), /帧数/);
  assert.throws(() => project([{ data: row([RED]), delay: 1501 }]), /时长/);
  const wide = gifBytes([{ data: row([RED]) }]);
  wide[6] = 1; wide[7] = 4; // 1025-wide logical canvas; 1-pixel descriptor is still valid.
  assert.throws(() => new GifProject(wide), /尺寸/);
  const large = gifBytes(Array.from({ length: 32 }, () => ({ data: row([RED]), delay: 1 })));
  large[6] = 0; large[7] = 4; large[8] = 0; large[9] = 4;
  assert.throws(() => new GifProject(large), /总像素/);
});

test('rejects invalid frame and stroke inputs before recording them', () => {
  const p = editFixture();
  for (const index of [-1, 3, 0.5, NaN]) {
    assert.throws(() => p.original(index), /帧序号/);
    assert.throws(() => p.addStroke(index, stroke('erase', 1)), /帧序号/);
    assert.throws(() => p.undo(index), /帧序号/);
  }
  for (const input of [null, { tool: 'erase', radius: 1, points: [] },
    { tool: 'erase', radius: 1, points: Array(1025).fill({ x: 0, y: 0 }) },
    stroke('unknown', 1), stroke('erase', Infinity), { ...stroke('erase', 1), radius: 0 }]) {
    assert.throws(() => p.addStroke(0, input));
    assert.equal(p.strokes[0].length, 0);
  }
});

test('enforces per-frame and total stroke limits, freeing capacity through undo', () => {
  const p = project(Array.from({ length: 11 }, () => ({ data: row([RED]) })));
  for (let frame = 0; frame < 10; frame++) {
    for (let i = 0; i < 100; i++) p.addStroke(frame, stroke('erase', 0.5));
  }
  assert.throws(() => p.addStroke(0, stroke('erase', 0.5)), /上限/);
  assert.throws(() => p.addStroke(10, stroke('erase', 0.5)), /上限/);
  p.undo(0);
  p.addStroke(10, stroke('restore', 0.5));
  assert.equal(p.strokes[10].length, 1);
});

const ffmpegAvailable = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
test('independent ffmpeg decoding confirms transparent edited export and visible colours', { skip: !ffmpegAvailable }, async () => {
  const p = editFixture();
  p.addStroke(0, stroke('restore', 0.5));
  p.addStroke(1, stroke('erase', 3.5));
  const output = await p.encode();
  const external = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vsync', '0',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'
  ], { input: output, maxBuffer: 1024 * 1024 });
  assert.equal(external.status, 0, external.stderr.toString());
  const frameBytes = p.width * p.height * 4;
  assert.equal(external.stdout.length, frameBytes * p.gif.frameCount);
  for (let frame = 0; frame < p.gif.frameCount; frame++) {
    const expected = p.render(frame);
    const actual = external.stdout.subarray(frame * frameBytes, (frame + 1) * frameBytes);
    for (let offset = 0; offset < expected.length; offset += 4) {
      assert.equal(actual[offset + 3], expected[offset + 3]);
      if (expected[offset + 3]) assert.deepEqual(Array.from(actual.subarray(offset, offset + 4)), Array.from(expected.slice(offset, offset + 4)));
    }
  }
});
