// Everything that can be checked without a browser: the ff library and the
// text output writers.
//
// The hash comparison is the safety net for dependency upgrades. SVG, DXF,
// HTML, CSV, TAB and the on-screen table all come out of pure ff functions
// that do not touch jQuery, Raphael or jsPDF, so swapping any of those
// libraries must leave every hash untouched. A changed hash is a regression.
//
//   node test/harness/outputs.test.js            check against baseline.json
//   node test/harness/outputs.test.js --update   rewrite baseline.json
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createReport, loadFF, inlineUiScript, buildGuitar, textOutputs, sha256, DISPLAY_OPTIONS } = require('./lib.js');

const BASELINE = path.join(__dirname, 'baseline.json');
const UPDATE = process.argv.includes('--update');
const ff = loadFF();
const r = createReport('outputs (no browser)');

// ------------------------------------------------------------ unit arithmetic

for (const [value, mm] of [[25, 635], [1.375, 34.925], [2.125, 53.975], [0.09375, 2.38125], [28, 711.2]]) {
    const toMM = ff.convertLength(value, 'in', 'mm');
    const back = ff.convertLength(toMM, 'mm', 'in');
    r.check(`convertLength ${value} in <-> ${mm} mm round-trips exactly`, toMM === mm && back === value, `${toMM} / ${back}`);
}
r.check('convertLength 25 in -> 63.5 cm', ff.convertLength(25, 'in', 'cm') === 63.5);
r.check('convertLength gauge 0.010 in -> 0.254 mm', ff.convertLength(0.01, 'in', 'mm') === 0.254);
r.check('convertLength is identity for the same unit', ff.convertLength(7, 'mm', 'mm') === 7);
r.check('isKnownUnit accepts in/cm/mm', ['in', 'cm', 'mm'].every(ff.isKnownUnit));
r.check('isKnownUnit rejects anything else', !ff.isKnownUnit('furlong') && !ff.isKnownUnit(undefined));

// safeNumber is what keeps url fragment values out of generated html
r.check('safeNumber coerces a numeric string', ff.safeNumber('12.5', 0) === 12.5);
r.check('safeNumber rejects markup', ff.safeNumber('"><img src=x onerror=1>', 7) === 7);
r.check('safeNumber rejects NaN and undefined', ff.safeNumber(NaN, 3) === 3 && ff.safeNumber(undefined, 3) === 3);
r.check('safeNumber keeps zero', ff.safeNumber(0, 9) === 0);

// ------------------------------------------------------------- scale parsing

r.check('etScale rejects a zero tone count', ff.etScale(0, 2).errorstrings.length === 1);
r.check('etScale rejects a non-numeric tone count', ff.etScale(NaN, 2).errorstrings.length === 1);
r.check('etScale rejects a negative tone count', ff.etScale(-12, 2).errorstrings.length === 1);
r.check('etScale accepts 12', ff.etScale(12, 2).errorstrings.length === 0);
r.check('scalaScale flags a wrong tone count', ff.scalaScale('! x\ntitle\n5\n100.\n200.').errorstrings.length > 0);
r.check('scalaScale flags a zero denominator', ff.scalaScale('! x\ntitle\n1\n3/0').errorstrings.length > 0);
r.check('scalaScale flags an unparseable tone', ff.scalaScale('! x\ntitle\n1\nbanana').errorstrings.length > 0);
r.check('scalaScale accepts a valid file', ff.scalaScale('! x\ntitle\n2\n100.\n2/1').errorstrings.length === 0);
{
    const g = buildGuitar(ff, { units: 'in', scaleLength: 25, nutWidth: 1.375, bridgeWidth: 2.125, overhang: 0.09375 });
    g.scale = ff.etScale(0, 2);
    let threw = '';
    try { ff.fretGuitar(g); } catch (e) { threw = e.message; }
    r.check('fretGuitar fails loudly on a scale with no steps', threw.indexOf('no tones') > -1, threw);
}

// ------------------------------------------------------------- fret geometry

{
    const g = ff.fretGuitar(buildGuitar(ff, { units: 'in', scaleLength: 25, nutWidth: 1.375, bridgeWidth: 2.125, overhang: 0.09375 }));
    r.check('fretWidths are finite numbers', g.fretWidths.length > 0 && g.fretWidths.every(Number.isFinite), JSON.stringify(g.fretWidths.slice(0, 3)));
    r.check('a fret exists for every requested fret plus the nut', g.frets[0].length === 25);
    r.check('doPartials is on for a single scale length', g.doPartials === true);
}
{
    // push one string off the nut line so fretGuitar disables partials
    const g = buildGuitar(ff, { units: 'in', scaleLength: 25, nutWidth: 1.375, bridgeWidth: 2.125, overhang: 0.09375 });
    g.strings[2] = new ff.Segment(new ff.Point(g.strings[2].end1.x, 0.7), g.strings[2].end2.copy());
    const f = ff.fretGuitar(g);
    r.check('doPartials is off when a string leaves the nut line', f.doPartials === false);
    r.check('CSV omits the partial columns instead of writing NaN', (ff.getCSV(f).match(/NaN/g) || []).length === 0);
    r.check('TAB omits the partial columns instead of writing NaN', (ff.getTAB(f).match(/NaN/g) || []).length === 0);
    r.check('the html table omits them too', (ff.getTable(f).match(/NaN/g) || []).length === 0);
}

// -------------------------------------------------------------- table labels

{
    const g = ff.fretGuitar(buildGuitar(ff, { units: 'mm', scaleLength: 635, nutWidth: 34.925, bridgeWidth: 53.975, overhang: 2.38125 }));
    const labelled = ff.getTable(g, g.units);
    for (const header of ['length (mm)', 'endpoints (mm)', 'to nut (mm)', 'to bridge (mm)',
        'intersection point (mm)', 'partial width (mm)', 'mid to nut (mm)']) {
        r.check(`table header "${header}"`, labelled.indexOf(`<td>${header}</td>`) > -1);
    }
    r.check('angles are labelled as degrees, not as a length', labelled.indexOf('<td>angle (&deg;)</td>') > -1 && labelled.indexOf('angle (mm)') === -1);
    r.check('the degree sign is an entity, not a raw byte', labelled.indexOf('°') === -1);
    r.check('getTable without a unit label stays unlabelled', ff.getTable(g).indexOf('(mm)') === -1);
}

// ------------------------------------------------------------------- the DXF

for (const [unit, insunits, measurement] of [['in', 1, 0], ['cm', 5, 1], ['mm', 4, 1]]) {
    const g = ff.fretGuitar(buildGuitar(ff, Object.assign({ units: unit }, {
        in: { scaleLength: 25, nutWidth: 1.375, bridgeWidth: 2.125, overhang: 0.09375 },
        cm: { scaleLength: 63.5, nutWidth: 3.4925, bridgeWidth: 5.3975, overhang: 0.238125 },
        mm: { scaleLength: 635, nutWidth: 34.925, bridgeWidth: 53.975, overhang: 2.38125 },
    }[unit])));
    const dxf = ff.getDXF(g, DISPLAY_OPTIONS);
    r.check(`DXF declares $INSUNITS=${insunits} for ${unit}`, dxf.indexOf(`9\n$INSUNITS\n70\n${insunits}\n`) > -1);
    r.check(`DXF declares $MEASUREMENT=${measurement} for ${unit}`, dxf.indexOf(`9\n$MEASUREMENT\n70\n${measurement}\n`) > -1);
}

// --------------------------------------------------------------- the SVG box

{
    const g = ff.fretGuitar(buildGuitar(ff, { units: 'mm', scaleLength: 635, nutWidth: 34.925, bridgeWidth: 53.975, overhang: 2.38125 }));
    const svg = ff.getSVG(g, DISPLAY_OPTIONS);
    const box = /viewBox="([^"]+)"/.exec(svg)[1].split(' ').map(Number);
    const dims = /height="([^"]+)" width="([^"]+)"/.exec(svg);
    r.check('SVG carries the physical unit', dims[1] === '635mm', dims[1]);
    // viewBox is "min-x min-y width height", not "min-x min-y max-x max-y"
    r.check('viewBox width/height match the drawing', box[2] > 0 && box[3] > 0 && Math.abs(box[3] - 635) < 1, box.join(' '));
}

// ------------------------------------------------------- byte-for-byte hashes

const actual = {};
for (const unit of ['in', 'mm']) {
    actual[unit] = {};
    const outs = textOutputs(unit);
    for (const [name, text] of Object.entries(outs)) actual[unit][name] = sha256(text);
}

if (UPDATE) {
    fs.writeFileSync(BASELINE, JSON.stringify(actual, null, 2) + '\n');
    console.log('baseline.json rewritten');
} else if (!fs.existsSync(BASELINE)) {
    r.check('baseline.json exists (run with --update to create it)', false);
} else {
    const expected = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
    let mismatch = false;
    for (const unit of ['in', 'mm']) {
        for (const name of Object.keys(actual[unit])) {
            const ok = expected[unit] && expected[unit][name] === actual[unit][name];
            if (!ok) mismatch = true;
            r.check(`${unit} ${name} is byte-for-byte unchanged`, ok, ok ? '' : 'hash differs');
        }
    }
    // a hash tells you something broke but not what, so dump the real files
    if (mismatch) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fretfind-diff-'));
        for (const unit of ['in', 'mm']) {
            for (const [name, text] of Object.entries(textOutputs(unit))) {
                fs.writeFileSync(path.join(dir, `${unit}.${name}.txt`), text);
            }
        }
        console.log(`\n  current outputs written to ${dir} for diffing`);
    }
}

// ------------------------------------------------------ the inline ui script

{
    const file = path.join(os.tmpdir(), 'fretfind-inline-check.js');
    fs.writeFileSync(file, inlineUiScript());
    let error = '';
    try { execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }); }
    catch (e) { error = String(e.stderr || e).split('\n').slice(0, 3).join(' '); }
    fs.unlinkSync(file);
    r.check('the inline <script> in fretfind.html parses', error === '', error);
}

process.exitCode = r.print() ? 1 : 0;
