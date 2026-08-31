const rawExpectedVersionCode = process.argv[2] || '';

function fail(message) {
  console.error(`[verify-update-manifest-version] ${message}`);
  process.exitCode = 1;
}

if (!/^\d+$/.test(rawExpectedVersionCode)) {
  fail('usage: verify-update-manifest-version.mjs <expected-version-code>');
} else {
  const expectedVersionCode = Number(rawExpectedVersionCode);
  if (!Number.isSafeInteger(expectedVersionCode) || expectedVersionCode <= 0) {
    fail('usage: verify-update-manifest-version.mjs <expected-version-code>');
  } else {
    let body = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
      body += chunk;
    }

    let manifest;
    try {
      manifest = JSON.parse(body);
    } catch {
      fail('invalid update manifest JSON');
    }

    if (manifest !== undefined) {
      if (manifest?.versionCode !== expectedVersionCode) {
        fail(
          `expected versionCode ${expectedVersionCode}, received ${String(manifest?.versionCode)}`,
        );
      } else {
        console.log(JSON.stringify({ ok: true, versionCode: expectedVersionCode }));
      }
    }
  }
}
