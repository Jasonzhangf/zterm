import { readFileSync, writeFileSync } from 'node:fs';

const [, , sourcePath, outputPath] = process.argv;
if (!sourcePath || !outputPath) {
  throw new Error('usage: extract-remote-window-capture-swift.mjs <source.ts> <output.swift>');
}

const source = readFileSync(sourcePath, 'utf8');
const prefix = 'export const SCREEN_CAPTURE_KIT_FRAME_SOURCE_SWIFT = String.raw`';
const start = source.indexOf(prefix);
if (start < 0) {
  throw new Error('canonical ScreenCaptureKit source marker is missing');
}
const bodyStart = start + prefix.length;
const endMarker = '\n`;';
const end = source.indexOf(endMarker, bodyStart);
if (end < 0) {
  throw new Error('canonical ScreenCaptureKit source terminator is missing');
}

const swiftSource = source.slice(bodyStart, end).replace(/^\n/, '');
if (!swiftSource.includes('dispatchMain()')) {
  throw new Error('canonical ScreenCaptureKit source is incomplete');
}
writeFileSync(outputPath, swiftSource, 'utf8');
