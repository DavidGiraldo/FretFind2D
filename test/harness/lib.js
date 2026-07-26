// Shared plumbing for the FretFind2D test harness.
// No dependencies: Node 22+ (for the global WebSocket) and Chrome, nothing else.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');

// ---------------------------------------------------------------- assertions

function createReport(title) {
    const rows = [];
    return {
        check(label, pass, got) {
            rows.push({ label, pass: !!pass, got: got === undefined ? '' : String(got) });
        },
        rows,
        // returns the number of failures
        print() {
            console.log(`\n=== ${title} ===`);
            let failed = 0;
            for (const r of rows) {
                console.log((r.pass ? '  PASS  ' : '  FAIL  ') + r.label + (r.pass || !r.got ? '' : '   got: ' + r.got));
                if (!r.pass) failed++;
            }
            console.log(failed ? `  ${failed} of ${rows.length} FAILED` : `  all ${rows.length} passed`);
            return failed;
        },
    };
}

// ------------------------------------------------------------ the ff library

// fretfind.js is one IIFE assigned to a global and touches no DOM at load time,
// so it runs in a bare vm context. That is what lets the output writers be
// tested without a browser.
function loadFF() {
    const ctx = { window: {}, console };
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(SRC, 'fretfind.js'), 'utf8'), ctx);
    return ctx.ff;
}

// The inline <script> in fretfind.html is the UI layer and cannot run headless,
// but it can at least be parsed, which catches syntax errors before the browser
// suite spends a minute finding them.
function inlineUiScript() {
    const html = fs.readFileSync(path.join(SRC, 'fretfind.html'), 'utf8');
    return html.split('//<![CDATA[')[1].split('//]]>')[0];
}

// A replica of getGuitar() for lengthMode 'single' / spacing 'equal' /
// overhang 'equal'. getGuitar itself lives in the UI layer and needs the DOM.
function computeOffsets(strings, gauges, actualLength, perpWidth, spacingMode) {
    const offsets = [0];
    if (!isFinite(strings) || strings < 2) return offsets;
    const corrected = spacingMode === 'proportional' ? gauges : new Array(strings).fill(0);
    const workingArea = perpWidth - corrected.reduce((t, c) => t + c, 0);
    const perpGap = workingArea / (strings - 1);
    for (let i = 1; i < strings - 1; i++) {
        const half = (corrected[i - 1] + corrected[i]) / 2.0;
        offsets.push(offsets[i - 1] + (perpGap + half) * actualLength / perpWidth);
    }
    return offsets;
}

function buildGuitar(ff, { units, scaleLength, nutWidth, bridgeWidth, overhang, strings = 6, frets = 24 }) {
    const scale = ff.etScale(12, 2);
    const nutHalf = nutWidth / 2;
    const bridgeHalf = bridgeWidth / 2;
    const xcenter = Math.max(bridgeHalf + overhang, nutHalf + overhang);
    const first = new ff.Segment(new ff.Point(xcenter + nutHalf, 0), new ff.Point(xcenter + bridgeHalf, scaleLength));
    const last = new ff.Segment(new ff.Point(xcenter - nutHalf, 0), new ff.Point(xcenter - bridgeHalf, scaleLength));
    const nut = new ff.Segment(first.end1.copy(), last.end1.copy());
    const bridge = new ff.Segment(first.end2.copy(), last.end2.copy());
    const edge1 = new ff.Segment(nut.pointAt(-overhang), bridge.pointAt(-overhang));
    const edge2 = new ff.Segment(nut.pointAt(nut.length() + overhang), bridge.pointAt(bridge.length() + overhang));
    const gauges = new Array(strings).fill(0);
    const nOff = computeOffsets(strings, gauges, nut.length(), nutWidth, 'equal');
    const bOff = computeOffsets(strings, gauges, bridge.length(), bridgeWidth, 'equal');
    const lines = [first];
    for (let i = 1; i <= strings - 2; i++) lines.push(new ff.Segment(nut.pointAt(nOff[i]), bridge.pointAt(bOff[i])));
    if (strings > 1) lines.push(last);
    return {
        scale, tuning: new Array(strings).fill(0), strings: lines,
        edge1, edge2, center: xcenter, fret_count: frets, units,
    };
}

const DISPLAY_OPTIONS = {
    showStrings: true, showFretboardEdges: true, showMetas: true,
    showBoundingBox: false, extendFrets: false,
};

// The same design expressed in each unit, so a conversion bug shows up as a
// changed hash rather than as silently different geometry.
const DESIGNS = {
    in: { scaleLength: 25, nutWidth: 1.375, bridgeWidth: 2.125, overhang: 0.09375 },
    mm: { scaleLength: 635, nutWidth: 34.925, bridgeWidth: 53.975, overhang: 2.38125 },
};

// Every writer that does not need a browser. getPDF is absent on purpose:
// jsPDF needs a DOM, so the PDF path is covered by the browser suite.
function textOutputs(unit) {
    const ff = loadFF();
    const g = ff.fretGuitar(buildGuitar(ff, Object.assign({ units: unit }, DESIGNS[unit])));
    return {
        SVG: ff.getSVG(g, DISPLAY_OPTIONS),
        DXF: ff.getDXF(g, DISPLAY_OPTIONS),
        HTML: ff.getHTML(g),
        CSV: ff.getCSV(g),
        TAB: ff.getTAB(g),
        table_plain: ff.getTable(g),
        table_units: ff.getTable(g, g.units),
    };
}

const sha256 = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

// ------------------------------------------------------------ browser driver

function findChrome() {
    if (process.env.CHROME) return process.env.CHROME;
    const candidates = [
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        '/usr/bin/google-chrome',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ];
    const found = candidates.find(p => fs.existsSync(p));
    if (!found) throw new Error('No Chrome found. Set the CHROME environment variable to its path.');
    return found;
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

// Serves the repo root, so the suite can reach both src/ and test/.
function serve(port) {
    const server = http.createServer((req, res) => {
        const file = path.join(ROOT, decodeURIComponent(req.url.split('?')[0].split('#')[0]));
        if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
        fs.readFile(file, (err, buf) => {
            if (err) { res.writeHead(404); res.end(); return; }
            res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
            res.end(buf);
        });
    });
    server.listen(port);
    return server;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJSON = url => new Promise((resolve, reject) => {
    http.get(url, r => { let d = ''; r.on('data', c => (d += c)); r.on('end', () => resolve(JSON.parse(d))); }).on('error', reject);
});

async function openBrowser({ port, cdpPort }) {
    const server = serve(port);
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fretfind-test-'));
    const chrome = spawn(findChrome(), [
        '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
        '--hide-scrollbars', '--window-size=1400,900',
        '--remote-debugging-port=' + cdpPort, '--user-data-dir=' + profile, 'about:blank',
    ], { stdio: 'ignore' });

    let targets;
    for (let i = 0; i < 80; i++) {
        await sleep(250);
        try {
            targets = (await getJSON(`http://127.0.0.1:${cdpPort}/json/list`)).filter(t => t.type === 'page');
            if (targets.length) break;
        } catch { /* chrome not listening yet */ }
    }
    if (!targets || !targets.length) throw new Error('Chrome never exposed a debugging target');

    const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
    await new Promise(r => ws.addEventListener('open', r));
    const pending = new Map();
    const listeners = new Set();
    let nextId = 0;
    ws.addEventListener('message', ev => {
        const msg = JSON.parse(ev.data);
        if (msg.method) {
            for (const fn of Array.from(listeners)) fn(msg.method, msg.params);
            return;
        }
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
    });
    const send = (method, params) => {
        const id = ++nextId;
        ws.send(JSON.stringify({ id, method, params: params || {} }));
        return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    };

    await send('Page.enable');
    await send('Runtime.enable');

    // awaitPromise so an expression can read a Blob through FileReader
    async function evaluate(expression) {
        const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) {
            const e = r.exceptionDetails.exception || {};
            return { __threw: String(e.description || e.value || 'unknown').split('\n')[0] };
        }
        return r.result.value;
    }

    // Records uncaught errors so "did the page blow up?" is a real assertion.
    // Registered once: the binding survives navigation, and re-adding it on every
    // load made a single error show up once per load performed so far.
    await send('Page.addScriptToEvaluateOnNewDocument', {
        source: 'window.__errs=[];addEventListener("error",e=>window.__errs.push(String(e.message)));',
    });

    // The app has finished when it has drawn a table or reported why it cannot.
    // Testing `$('#tables').html().length > 0` does NOT work: the markup ships
    // with a `<!-- -->` placeholder inside #tables, so that is already true
    // before anything renders and load() would not wait at all.
    const RENDERED = "document.readyState==='complete' && !!window.ff && " +
        "($('#tables').find('table').length>0 || $('#errors').css('display')==='block')";

    // Always goes via about:blank first: navigating between two urls that differ
    // only by fragment is a same-document navigation, so the page would keep its
    // state and updateFormFromHash would never run again.
    async function load(url, ready) {
        await send('Page.navigate', { url: 'about:blank' });
        await sleep(120);
        await send('Page.navigate', { url });
        const readyExpr = ready || RENDERED;
        for (let i = 0; i < 120; i++) {
            await sleep(100);
            try { if (await evaluate(readyExpr) === true) return; } catch { /* context swapping */ }
        }
        throw new Error('page never became ready: ' + url);
    }

    const appUrl = hash => `http://127.0.0.1:${port}/src/fretfind.html` + (hash || '');

    // Chrome is launched at one fixed size, so without this nothing in the suite
    // ever crosses a media query. Note --hide-scrollbars is on, so this measures
    // layout without scrollbar reflow.
    async function setViewport(width, height) {
        await send('Emulation.setDeviceMetricsOverride', {
            width, height, deviceScaleFactor: 1, mobile: false,
        });
    }

    // Waits for Chrome's own "this download finished" signal and hands back the
    // path it wrote. Watching the directory instead is unreliable: the file is
    // created before it is filled, and an unrelated stray .crdownload in the same
    // folder is enough to make a poll pick the wrong entry or time out.
    async function download(trigger, timeoutMs = 20000) {
        const done = new Promise((resolve, reject) => {
            const timer = setTimeout(() => { listeners.delete(fn); reject(new Error('download timed out')); }, timeoutMs);
            const fn = (method, params) => {
                if (method !== 'Browser.downloadProgress') return;
                if (params.state === 'completed') {
                    clearTimeout(timer); listeners.delete(fn); resolve(params.filePath);
                } else if (params.state === 'canceled') {
                    clearTimeout(timer); listeners.delete(fn); reject(new Error('download canceled'));
                }
            };
            listeners.add(fn);
        });
        await trigger();
        return done;
    }

    return {
        evaluate, load, appUrl, send, download, setViewport,
        url: p => `http://127.0.0.1:${port}${p}`,
        async close() {
            try { ws.close(); } catch { /* already gone */ }
            chrome.kill();
            server.close();
            try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* chrome may still hold it */ }
        },
    };
}

module.exports = {
    ROOT, SRC, DISPLAY_OPTIONS, DESIGNS,
    createReport, loadFF, inlineUiScript, buildGuitar, textOutputs, sha256, openBrowser, sleep,
};
