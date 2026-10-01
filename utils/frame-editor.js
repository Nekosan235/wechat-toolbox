'use strict';

const MAX_PIXELS = 2048 * 2048;

function validateFrame(data, width, height) {
  if (!(data instanceof Uint8ClampedArray)) {
    throw new TypeError('Frame data must be a Uint8ClampedArray');
  }
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 ||
      height < 1 || width * height > MAX_PIXELS || data.length !== width * height * 4) {
    throw new RangeError('Invalid frame dimensions or RGBA data length');
  }
}

function validateStroke(stroke) {
  if (!stroke || !['erase', 'restore', 'paint'].includes(stroke.tool)) {
    throw new TypeError('Stroke tool must be erase, restore or paint');
  }
  if (stroke.tool === 'paint' && (!Array.isArray(stroke.color) || stroke.color.length !== 3 ||
      !stroke.color.every(value => Number.isInteger(value) && value >= 0 && value <= 255))) {
    throw new RangeError('Paint colour must contain three RGB bytes');
  }
  if (!Number.isFinite(stroke.radius) || stroke.radius < 1 || stroke.radius > 40) {
    throw new RangeError('Brush radius must be between 1 and 40');
  }
  if (!Array.isArray(stroke.points)) throw new TypeError('Stroke points must be an array');
  if (stroke.points.length > 1024) throw new RangeError('A stroke may contain at most 1024 points');
  for (let index = 0; index < stroke.points.length; index += 1) {
    const point = stroke.points[index];
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      throw new RangeError('Brush coordinates must be finite numbers');
    }
    if (index > 0) {
      const previous = stroke.points[index - 1];
      if (!Number.isFinite(point.x - previous.x) || !Number.isFinite(point.y - previous.y)) {
        throw new RangeError('Brush segment coordinates exceed the numeric range');
      }
    }
  }
}

// Liang-Barsky clipping prevents an off-image drag from creating an unbounded
// interpolation loop. The expanded box also includes brushes near an edge.
function clipSegment(from, to, width, height, radius) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  let start = 0;
  let end = 1;
  const limits = [
    [-dx, from.x + radius], [dx, width + radius - from.x],
    [-dy, from.y + radius], [dy, height + radius - from.y]
  ];
  for (const [direction, distance] of limits) {
    if (direction === 0) {
      if (distance < 0) return null;
      continue;
    }
    const ratio = distance / direction;
    if (direction < 0) start = Math.max(start, ratio);
    else end = Math.min(end, ratio);
    if (start > end) return null;
  }
  return {
    x1: from.x + start * dx, y1: from.y + start * dy,
    x2: from.x + end * dx, y2: from.y + end * dy
  };
}

/**
 * Apply one circular brush stroke in output-image coordinates. Pixel centres
 * lie at x + 0.5, y + 0.5. Erase only changes alpha; restore copies original
 * RGBA, including its alpha. Paint writes RGB with full alpha. target must
 * not share storage with original.
 */
function applyStroke(target, original, width, height, stroke) {
  validateFrame(target, width, height);
  validateFrame(original, width, height);
  validateStroke(stroke);
  if (target.buffer === original.buffer &&
      target.byteOffset < original.byteOffset + original.byteLength &&
      original.byteOffset < target.byteOffset + target.byteLength) {
    throw new TypeError('Edited pixels must not overlap the original frame');
  }

  const radius = stroke.radius;
  const radiusSquared = radius * radius;
  const restore = stroke.tool === 'restore';
  function stamp(cx, cy) {
    const left = Math.max(0, Math.ceil(cx - radius - 0.5));
    const right = Math.min(width - 1, Math.floor(cx + radius - 0.5));
    const top = Math.max(0, Math.ceil(cy - radius - 0.5));
    const bottom = Math.min(height - 1, Math.floor(cy + radius - 0.5));
    for (let y = top; y <= bottom; y += 1) {
      for (let x = left; x <= right; x += 1) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        if (dx * dx + dy * dy > radiusSquared) continue;
        const offset = (y * width + x) * 4;
        if (restore) {
          target[offset] = original[offset];
          target[offset + 1] = original[offset + 1];
          target[offset + 2] = original[offset + 2];
          target[offset + 3] = original[offset + 3];
        } else if (stroke.tool === 'paint') {
          target[offset] = stroke.color[0];
          target[offset + 1] = stroke.color[1];
          target[offset + 2] = stroke.color[2];
          target[offset + 3] = 255;
        } else target[offset + 3] = 0;
      }
    }
  }

  if (stroke.points.length === 1) stamp(stroke.points[0].x, stroke.points[0].y);
  const spacing = Math.max(0.5, radius / 2);
  for (let index = 1; index < stroke.points.length; index += 1) {
    const segment = clipSegment(stroke.points[index - 1], stroke.points[index], width, height, radius);
    if (!segment) continue;
    const dx = segment.x2 - segment.x1;
    const dy = segment.y2 - segment.y1;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / spacing));
    for (let step = 0; step <= steps; step += 1) {
      const amount = step / steps;
      stamp(segment.x1 + dx * amount, segment.y1 + dy * amount);
    }
  }
  return target;
}

function renderEditedFrame(base, original, width, height, strokes) {
  validateFrame(base, width, height);
  validateFrame(original, width, height);
  if (!Array.isArray(strokes)) throw new TypeError('Strokes must be an array');
  const result = new Uint8ClampedArray(base);
  for (const stroke of strokes) applyStroke(result, original, width, height, stroke);
  return result;
}

function resizeFrame(data, width, height, targetWidth, targetHeight) {
  validateFrame(data, width, height);
  if (!Number.isInteger(targetWidth) || !Number.isInteger(targetHeight) ||
      targetWidth < 1 || targetHeight < 1 || targetWidth * targetHeight > MAX_PIXELS) {
    throw new RangeError('Invalid target dimensions');
  }
  const result = new Uint8ClampedArray(targetWidth * targetHeight * 4);
  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY = Math.floor(y * height / targetHeight);
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = Math.floor(x * width / targetWidth);
      const sourceOffset = (sourceY * width + sourceX) * 4;
      const targetOffset = (y * targetWidth + x) * 4;
      result[targetOffset] = data[sourceOffset];
      result[targetOffset + 1] = data[sourceOffset + 1];
      result[targetOffset + 2] = data[sourceOffset + 2];
      result[targetOffset + 3] = data[sourceOffset + 3];
    }
  }
  return result;
}

module.exports = { applyStroke, renderEditedFrame, resizeFrame };
