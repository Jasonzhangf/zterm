#!/usr/bin/env node

const entry = new URL('../dist/main.mjs', import.meta.url);

try {
  await import(entry);
} catch (error) {
  if (error?.code === 'ERR_MODULE_NOT_FOUND' && String(error.message).includes(entry.pathname)) {
    console.error('zterm: packaged CLI entry is missing; run the package build before installing.');
    process.exitCode = 1;
  } else {
    throw error;
  }
}
