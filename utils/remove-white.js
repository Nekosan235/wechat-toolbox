'use strict';

const MAX_PIXELS = 2048 * 2048;

/**
 * Remove near-white pixels without changing the input image.
 *
 * tolerance: distance from white that becomes fully transparent (0..255).
 * feather: additional distance over which opacity gradually returns (0..255).
 * Near-white candidates must also have an RGB spread of at most 12, to avoid
 * treating pale coloured areas as neutral white. edge mode uses 4-neighbour
 * connectivity; already transparent pixels can connect background regions.
 * removedPixels counts pixels whose existing alpha was reduced, including
 * partially softened pixels. Existing fully transparent pixels are untouched.
 */
function removeWhiteBackground(source, width, height, options = {}) {
  if (!(source instanceof Uint8ClampedArray)) {
    throw new TypeError('source must be an RGBA Uint8ClampedArray');
  }
  if (!Number.isInteger(width) || !Number.isInteger(height) ||
      width < 1 || height < 1 || width * height > MAX_PIXELS) {
    throw new RangeError('Image dimensions must be positive integers with at most 2048² pixels');
  }
  const pixelCount = width * height;
  if (source.length !== pixelCount * 4) {
    throw new RangeError('RGBA data length does not match image dimensions');
  }
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('options must be an object');
  }
  const { tolerance = 32, mode = 'edge', feather = 12 } = options;
  for (const value of [tolerance, feather]) {
    if (!Number.isFinite(value) || value < 0 || value > 255) {
      throw new RangeError('tolerance and feather must be finite numbers between 0 and 255');
    }
  }
  if (mode !== 'edge' && mode !== 'all') {
    throw new RangeError('mode must be edge or all');
  }

  const data = new Uint8ClampedArray(source);
  const cutoff = Math.min(255, tolerance + feather);
  const chromaLimit = Math.min(12, cutoff);
  let removedPixels = 0;

  function isCandidate(offset) {
    if (source[offset + 3] === 0) return true;
    const minimum = Math.min(source[offset], source[offset + 1], source[offset + 2]);
    const maximum = Math.max(source[offset], source[offset + 1], source[offset + 2]);
    return 255 - minimum <= cutoff && maximum - minimum <= chromaLimit;
  }

  function soften(offset) {
    const originalAlpha = source[offset + 3];
    if (originalAlpha === 0) return;
    const distance = 255 - Math.min(source[offset], source[offset + 1], source[offset + 2]);
    const factor = distance <= tolerance ? 0 : (distance - tolerance) / feather;
    const alpha = Math.round(originalAlpha * Math.min(1, factor));
    if (alpha < originalAlpha) {
      data[offset + 3] = alpha;
      removedPixels += 1;
    }
  }

  if (mode === 'all') {
    for (let offset = 0; offset < source.length; offset += 4) {
      if (isCandidate(offset)) soften(offset);
    }
    return { data, removedPixels };
  }

  // 0: not background; 1: candidate; 2: queued/visited. Fixed-size typed arrays
  // keep a large all-white image from creating millions of JS queue objects.
  const mask = new Uint8Array(pixelCount);
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    if (isCandidate(pixel * 4)) mask[pixel] = 1;
  }
  const queue = new Int32Array(pixelCount);
  let head = 0;
  let tail = 0;

  function enqueue(pixel) {
    if (mask[pixel] !== 1) return;
    mask[pixel] = 2;
    queue[tail] = pixel;
    tail += 1;
  }

  for (let x = 0; x < width; x += 1) {
    enqueue(x);
    enqueue((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    enqueue(y * width);
    enqueue(y * width + width - 1);
  }

  while (head < tail) {
    const pixel = queue[head];
    head += 1;
    soften(pixel * 4);
    const x = pixel % width;
    if (x > 0) enqueue(pixel - 1);
    if (x + 1 < width) enqueue(pixel + 1);
    if (pixel >= width) enqueue(pixel - width);
    if (pixel + width < pixelCount) enqueue(pixel + width);
  }
  return { data, removedPixels };
}

module.exports = { removeWhiteBackground };
