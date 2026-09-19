#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { constants as osConstants } from "node:os";

const severities = new Set(["block", "warn", "info"]);

function usage(message) {
  if (message) console.error(`run-gate: ${message}`);
  console.error("usage: run-gate.mjs --severity <block|warn|info> --name <gate> -- <command> [args...]");
  process.exit(2);
}

const args = process.argv.slice(2);
const separator = args.indexOf("--");
if (separator < 0) usage("missing command separator --");

const options = args.slice(0, separator);
const command = args.slice(separator + 1);
let severity;
let name;

for (let index = 0; index < options.length; index += 1) {
  const option = options[index];
  if (option === "--severity") {
    severity = options[++index];
  } else if (option === "--name") {
    name = options[++index];
  } else {
    usage(`unknown option ${option}`);
  }
}

if (!severities.has(severity)) usage(`invalid severity ${severity ?? "<missing>"}`);
if (!name) usage("missing gate name");
if (command.length === 0) usage("missing command");

const result = spawnSync(command[0], command.slice(1), { stdio: "inherit" });
const signalNumber = result.signal ? osConstants.signals[result.signal] : undefined;
const exitCode = result.status ?? (signalNumber ? 128 + signalNumber : 1);
if (exitCode === 0 && !result.error) process.exit(0);

const label = severity.toUpperCase();
const detail = result.error
  ? result.error.message
  : result.signal
    ? `signal ${result.signal} (exit ${exitCode})`
    : `exit ${exitCode}`;
const line = `[${label}] ${name}: ${detail}\n`;
if (severity === "info") {
  process.stdout.write(line);
} else {
  process.stderr.write(line);
}

process.exit(severity === "block" ? exitCode : 0);
