#!/usr/bin/env node
/**
 * Pixel-domain clarity analyzer for remote-window streaming.
 *
 * It reads the phone's own framebuffer (`adb screencap`) together with the
 * video element rect recorded by `remote-window-perf-baseline.mjs`, crops the
 * streamed pixels out of that screenshot and measures three losses that a
 * terminal-style text stream suffers:
 *
 *   1. resolution  - modulation depth of 1px lines at increasing pitch, which
 *                    also yields the effective device pixels per source pixel;
 *   2. chroma      - amplitude retention of 1px red/blue stripes against solid
 *                    red/blue references (4:2:0 subsampling loss);
 *   3. text edge   - high-frequency energy of 13/11/9px monospace and CJK text.
 *
 * Every metric is a ratio against a reference drawn in the same screenshot, so
 * a measurement is comparable across runs without an external golden image.
 * PNG decoding uses only Node's zlib: the analyzer must run anywhere the
 * evidence bundle is opened, with no extra dependency.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('not a PNG file');
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);
      if (colorType !== 6 && colorType !== 2) throw new Error(`unsupported color type ${colorType}`);
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  const channels = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(width * height * 4);
  let previous = Buffer.alloc(stride);
  let rawOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[rawOffset];
    rawOffset += 1;
    const line = Buffer.from(raw.subarray(rawOffset, rawOffset + stride));
    rawOffset += stride;
    for (let index = 0; index < stride; index += 1) {
      const left = index >= channels ? line[index - channels] : 0;
      const up = previous[index];
      const upLeft = index >= channels ? previous[index - channels] : 0;
      let value = line[index];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const estimate = left + up - upLeft;
        const dl = Math.abs(estimate - left);
        const du = Math.abs(estimate - up);
        const dul = Math.abs(estimate - upLeft);
        value += (dl <= du && dl <= dul) ? left : (du <= dul ? up : upLeft);
      }
      line[index] = value & 0xff;
    }
    for (let x = 0; x < width; x += 1) {
      const source = x * channels;
      const target = (y * width + x) * 4;
      pixels[target] = line[source];
      pixels[target + 1] = line[source + 1];
      pixels[target + 2] = line[source + 2];
      pixels[target + 3] = channels === 4 ? line[source + 3] : 255;
    }
    previous = line;
  }
  return { width, height, pixels };
}

function luminance(image, x, y) {
  const index = (y * image.width + x) * 4;
  return 0.2126 * image.pixels[index] + 0.7152 * image.pixels[index + 1] + 0.0722 * image.pixels[index + 2];
}

function meanLuma(image, rect) {
  let total = 0;
  let count = 0;
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      total += luminance(image, x, y);
      count += 1;
    }
  }
  return count === 0 ? null : total / count;
}

/**
 * Horizontal modulation depth: the difference between the brightest and the
 * darkest column average inside a region, divided by their sum. A resolvable
 * pattern keeps a high value; once the pattern is finer than the display can
 * carry, the columns average out and the value collapses.
 */
function horizontalModulation(image, rect) {
  const columns = [];
  for (let x = rect.x; x < rect.x + rect.width; x += 1) {
    let total = 0;
    for (let y = rect.y; y < rect.y + rect.height; y += 1) {
      total += luminance(image, x, y);
    }
    columns.push(total / rect.height);
  }
  if (columns.length < 4) return null;
  const sorted = [...columns].sort((left, right) => left - right);
  const low = sorted[Math.floor(sorted.length * 0.1)];
  const high = sorted[Math.floor(sorted.length * 0.9)];
  return { low, high, modulation: high + low === 0 ? 0 : (high - low) / (high + low) };
}

/** Mean absolute horizontal gradient: high-frequency energy of text strokes. */
function horizontalGradientEnergy(image, rect) {
  let total = 0;
  let count = 0;
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x + 1; x < rect.x + rect.width; x += 1) {
      total += Math.abs(luminance(image, x, y) - luminance(image, x - 1, y));
      count += 1;
    }
  }
  return count === 0 ? null : total / count;
}

/**
 * Chroma amplitude retention. 1px red/blue stripes carry chroma at the display
 * Nyquist limit; 4:2:0 averages them into a nearly neutral colour. The solid
 * red and solid blue blocks in the same screenshot give the unreduced
 * amplitude, so the ratio is independent of tone mapping and of the encoder's
 * colour conversion.
 */
function chromaMetrics(image, stripeRect, redRect, blueRect) {
  const stripeAmplitude = meanChannelDifference(image, stripeRect);
  const solidAmplitude = (
    meanChannelDifference(image, redRect) + meanChannelDifference(image, blueRect)
  ) / 2;
  return {
    stripeAmplitude,
    solidAmplitude,
    retention: solidAmplitude > 0 ? stripeAmplitude / solidAmplitude : null,
  };
}

function meanChannelDifference(image, rect) {
  let total = 0;
  let count = 0;
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      const index = (y * image.width + x) * 4;
      total += Math.abs(image.pixels[index] - image.pixels[index + 2]);
      count += 1;
    }
  }
  return count === 0 ? null : total / count;
}

/**
 * Hue of a mean row colour in degrees, or null when the row is not saturated
 * enough to be a separator. Separators are matched by hue instead of by exact
 * RGB: a terminal renders its own ANSI palette, VP8 shifts colour, and the
 * phone compositor rescales, so only the hue of a full-width band survives the
 * whole path while exact channels do not.
 */
function rowHue(red, green, blue) {
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const chroma = max - min;
  if (chroma < 60 || max < 40) {
    return null;
  }
  let hue;
  if (max === red) {
    hue = 60 * (((green - blue) / chroma) % 6);
  } else if (max === green) {
    hue = 60 * ((blue - red) / chroma + 2);
  } else {
    hue = 60 * ((red - green) / chroma + 4);
  }
  return (hue + 360) % 360;
}

function hueDistance(left, right) {
  const delta = Math.abs(left - right) % 360;
  return delta > 180 ? 360 - delta : delta;
}

/** Locate a horizontal run of rows whose hue matches the separator band. */
function findSeparators(image, videoRect, separators, candidates = []) {
  const found = [];
  for (let y = videoRect.y; y < videoRect.y + videoRect.height; y += 1) {
    let red = 0;
    let green = 0;
    let blue = 0;
    let count = 0;
    for (let x = videoRect.x; x < videoRect.x + videoRect.width; x += 1) {
      const index = (y * image.width + x) * 4;
      red += image.pixels[index];
      green += image.pixels[index + 1];
      blue += image.pixels[index + 2];
      count += 1;
    }
    const hue = rowHue(red / count, green / count, blue / count);
    let best = null;
    if (hue !== null) {
      for (const separator of separators) {
        const distance = hueDistance(hue, separator.hue);
        if (distance <= 25 && (best === null || distance < best.distance)) {
          best = { separator, distance, hue };
        }
      }
    }
    if (best) {
      candidates.push({
        y: y - videoRect.y,
        name: best.separator.name,
        hue: Math.round(best.hue),
        hueDistance: Math.round(best.distance),
        rgb: [Math.round(red / count), Math.round(green / count), Math.round(blue / count)],
      });
      if (best.separator.rows.length > 0 && y - best.separator.rows.at(-1) > 2) {
        // A second separated run of the same colour is still useful evidence;
        // keep the latest contiguous run as the separator body.
        best.separator.rows = [];
      }
      best.separator.rows.push(y);
    }
  }
  for (const separator of separators) {
    if (separator.rows.length > 0) {
      found.push({
        name: separator.name,
        hue: separator.hue,
        top: separator.rows[0],
        bottom: separator.rows.at(-1),
      });
    }
  }
  return found.sort((left, right) => left.top - right.top);
}

function main() {
  const args = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--screenshot') options.screenshot = args[++index];
    else if (args[index] === '--frame') options.frame = args[++index];
    else if (args[index] === '--baseline') options.baseline = args[++index];
    else if (args[index] === '--out') options.out = args[++index];
    else if (args[index] === '--help') options.help = true;
    else throw new Error(`unknown argument: ${args[index]}`);
  }
  if (options.help || (!options.screenshot && !options.frame)) {
    console.log('usage: node scripts/remote-window-clarity-analyze.mjs (--frame <decoded-frame.png> | --screenshot <png> --baseline <baseline.json>) [--out <dir>]');
    return;
  }

  // Two evidence sources: the decoded frame carries the exact streamed pixels
  // (codec truth) and needs no crop, while the phone screenshot additionally
  // carries the display scaling the eye sees and is cropped to the video
  // element rect that the baseline harness recorded.
  const baseline = options.baseline ? JSON.parse(readFileSync(options.baseline, 'utf8')) : null;
  const image = decodePng(readFileSync(resolve(options.frame ?? options.screenshot)));
  let rect;
  if (options.frame) {
    rect = { x: 0, y: 0, width: image.width, height: image.height };
  } else {
    const lastSample = (baseline?.raw?.samples ?? []).at(-1) ?? baseline?.video ?? null;
    const videoRect = lastSample?.videoRect ?? null;
    if (!videoRect) {
      throw new Error('baseline has no videoRect; re-run remote-window-perf-baseline.mjs');
    }
    const dpr = lastSample.devicePixelRatio ?? 1;
    rect = {
      x: Math.max(0, Math.round(videoRect.x * dpr)),
      y: Math.max(0, Math.round(videoRect.y * dpr)),
      width: Math.min(image.width - Math.round(videoRect.x * dpr), Math.round(videoRect.width * dpr)),
      height: Math.min(image.height - Math.round(videoRect.y * dpr), Math.round(videoRect.height * dpr)),
    };
  }

  const separators = [
    { name: 'lines', hue: 120, rows: [] },
    { name: 'chroma', hue: 300, rows: [] },
    { name: 'text', hue: 60, rows: [] },
    { name: 'patterns', hue: 180, rows: [] },
    { name: 'end', hue: 0, rows: [] },
  ];
  const separatorCandidates = [];
  const found = findSeparators(image, rect, separators, separatorCandidates);
  if (found.length < 3) {
    const saturated = [...separatorCandidates]
      .sort((left, right) => left.y - right.y)
      .slice(0, 8)
      .map((entry) => `y=${entry.y} hue=${entry.hue} nearest=${entry.name}`);
    throw new Error(
      `clarity card separators not found in the video crop (found ${found.length}); `
      + `the streamed frame is not the test card. Saturated rows seen: ${saturated.join(' ; ') || 'none'}`,
    );
  }

  const bandOf = (name) => {
    const index = found.findIndex((entry) => entry.name === name);
    if (index < 0 || index + 1 >= found.length) return null;
    const top = found[index].bottom + 1;
    const bottom = found[index + 1].top - 1;
    if (bottom - top < 6) return null;
    return { y: top, height: bottom - top, x: rect.x, width: rect.width };
  };

  const linesBand = bandOf('lines');
  const chromaBand = bandOf('chroma');
  const textBand = bandOf('text');
  const patternsBand = bandOf('patterns');

  const pitches = [1, 2, 3, 4, 5, 6];
  const lineMetrics = [];
  if (linesBand) {
    const rowHeight = Math.floor(linesBand.height / pitches.length);
    pitches.forEach((pitch, index) => {
      const row = {
        x: linesBand.x,
        y: linesBand.y + index * rowHeight + 2,
        width: linesBand.width,
        height: Math.max(4, rowHeight - 4),
      };
      lineMetrics.push({ pitchPx: pitch, ...(horizontalModulation(image, row) ?? {}) });
    });
  }

  let chroma = null;
  if (chromaBand) {
    const stripeHeight = Math.floor(chromaBand.height * 0.45);
    const stripes = {
      x: chromaBand.x,
      y: chromaBand.y + 2,
      width: chromaBand.width,
      height: stripeHeight,
    };
    const solidsTop = chromaBand.y + stripeHeight + 4;
    const solidsHeight = Math.max(4, chromaBand.y + chromaBand.height - solidsTop - 2);
    const half = Math.floor(chromaBand.width / 2);
    chroma = chromaMetrics(
      image,
      stripes,
      { x: chromaBand.x + 4, y: solidsTop, width: half - 8, height: solidsHeight },
      { x: chromaBand.x + half + 4, y: solidsTop, width: half - 8, height: solidsHeight },
    );
  }

  const textMetrics = {};
  if (textBand) {
    const rowHeight = Math.floor(textBand.height / 3);
    const labels = ['13px', '11px', '9px'];
    labels.forEach((label, index) => {
      textMetrics[label] = horizontalGradientEnergy(image, {
        x: textBand.x,
        y: textBand.y + index * rowHeight,
        width: textBand.width,
        height: rowHeight,
      });
    });
  }
  const patternMetrics = {};
  if (patternsBand) {
    patternMetrics.checker2 = horizontalGradientEnergy(image, {
      x: patternsBand.x,
      y: patternsBand.y + 2,
      width: patternsBand.width,
      height: Math.max(4, Math.floor(patternsBand.height * 0.25)),
    });
    patternMetrics.cjk13 = horizontalGradientEnergy(image, {
      x: patternsBand.x,
      y: patternsBand.y + Math.floor(patternsBand.height * 0.6),
      width: patternsBand.width,
      height: Math.max(4, Math.floor(patternsBand.height * 0.2)),
    });
  }

  const resolved = lineMetrics.filter((entry) => (entry.modulation ?? 0) >= 0.35);
  const finestResolvedPitch = resolved.length > 0 ? resolved[0].pitchPx : null;

  const firstHueRow = (predicate) => {
    for (let y = rect.y; y < rect.y + rect.height; y += 1) {
      let red = 0;
      let green = 0;
      let blue = 0;
      for (let x = rect.x; x < rect.x + rect.width; x += 1) {
        const index = (y * image.width + x) * 4;
        red += image.pixels[index];
        green += image.pixels[index + 1];
        blue += image.pixels[index + 2];
      }
      const hue = rowHue(red / rect.width, green / rect.width, blue / rect.width);
      if (hue !== null && predicate(hue)) return y - rect.y;
    }
    return null;
  };
  const firstRedRow = firstHueRow((hue) => hueDistance(hue, 0) <= 25);
  const firstBlueRow = firstHueRow((hue) => hueDistance(hue, 240) <= 25);
  const channelOrderCheck = {
    firstRedRow,
    firstBlueRow,
    redBeforeBlue: firstRedRow !== null && firstBlueRow !== null && firstRedRow < firstBlueRow,
  };

  const result = {
    analyzedAt: new Date().toISOString(),
    screenshot: options.screenshot ? resolve(options.screenshot) : null,
    frame: options.frame ? resolve(options.frame) : null,
    screenshotSize: { width: image.width, height: image.height },
    videoRect: rect,
    videoPixelSize: {
      width: baseline?.video?.videoWidth ?? image.width,
      height: baseline?.video?.videoHeight ?? image.height,
    },
    target: baseline?.binding?.targetText ?? null,
    codecMimeType: baseline?.binding?.codecMimeType ?? null,
    separators: found,
    separatorCandidates: separatorCandidates.slice(0, 24),
    bands: {
      lines: linesBand,
      chroma: chromaBand,
      text: textBand,
      patterns: patternsBand,
    },
    lineModulation: lineMetrics,
    finestResolvedPitchPx: finestResolvedPitch,
    channelOrderCheck,
    chroma,
    textEdgeEnergy: textMetrics,
    patternEdgeEnergy: patternMetrics,
    meanLuma: { video: meanLuma(image, rect) },
  };

  const outDir = options.out ?? dirname(resolve(options.screenshot));
  const jsonPath = join(outDir, 'clarity.json');
  writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
}

main();
