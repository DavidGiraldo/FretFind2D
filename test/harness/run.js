// Runs every suite. Exits non-zero if anything failed.
//
//   node test/harness/run.js
'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const suites = ['outputs.test.js', 'browser.test.js'];
let failed = 0;

for (const suite of suites) {
    const result = spawnSync(process.execPath, [path.join(__dirname, suite)], { stdio: 'inherit' });
    if (result.status !== 0) failed++;
}

console.log(failed ? `\n${failed} suite(s) FAILED\n` : '\nall suites passed\n');
process.exitCode = failed ? 1 : 0;
