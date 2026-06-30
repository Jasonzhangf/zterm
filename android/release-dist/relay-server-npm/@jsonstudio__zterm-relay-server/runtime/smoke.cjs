#!/usr/bin/env node
'use strict';

function readArg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return '';
  return process.argv[index + 1] || '';
}

function buildUrl(base, path) {
  return new URL(path.replace(/^\//, ''), base).toString();
}

async function readJson(response) {
  const text = await response.text();
  return text.trim() ? JSON.parse(text) : {};
}

async function main() {
  const baseUrl = readArg('--base-url') || process.env.RELAY_BASE_URL || process.env.ZTERM_RELAY_BASE_URL;
  if (!baseUrl) {
    throw new Error('zterm-relay-server smoke requires --base-url or RELAY_BASE_URL');
  }
  const username = readArg('--username') || process.env.RELAY_USERNAME;
  const password = readArg('--password') || process.env.RELAY_PASSWORD;
  const health = await fetch(buildUrl(baseUrl, '/health')).then(readJson);
  if (!health.ok) {
    throw new Error('relay health did not return ok=true');
  }
  const result = { ok: true, baseUrl, health: { ok: health.ok, basePath: health.basePath, turn: Boolean(health.turn), relay: health.relay || null } };
  if (username || password) {
    if (!username || !password) {
      throw new Error('both --username/RELAY_USERNAME and --password/RELAY_PASSWORD are required for login smoke');
    }
    const loginResponse = await fetch(buildUrl(baseUrl, '/api/auth/login'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const login = await readJson(loginResponse);
    if (!loginResponse.ok || !login.accessToken || !login.ws?.host || !login.ws?.client || !login.ws?.devices) {
      throw new Error('relay login smoke failed or ws endpoints are missing');
    }
    result.login = {
      ok: true,
      accessToken: '***',
      ws: login.ws,
      turn: login.turn ? { url: login.turn.url, username: login.turn.username, credential: '***' } : null,
    };
  }
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
