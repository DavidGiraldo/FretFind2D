// Everything that needs a real browser: the UI layer, jQuery behaviour, the
// permalink round-trip, the Raphael drawing and the jsPDF writers.
//
//   node test/harness/browser.test.js
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createReport, openBrowser } = require('./lib.js');

const PORT = 8231;
const CDP_PORT = 9231;

// A crafted permalink is the app's untrusted input: everything in the fragment
// is attacker-controlled in any link a user is sent.
const PAYLOAD = encodeURIComponent('"><img src=x onerror="window.__pwned=1">');

(async () => {
    const r = createReport('browser');
    const b = await openBrowser({ port: PORT, cdpPort: CDP_PORT });
    const noErrors = async () => JSON.stringify(await b.evaluate('window.__errs')) === '[]';
    const errs = async () => JSON.stringify(await b.evaluate('window.__errs'));

    try {
        // ------------------------------------------------------------- units

        await b.load(b.appUrl());
        // one label per length field: 14 fixed plus six each of ilengths and igauges
        const spans = "(function(){var s={},n=0;$('#worksheet span.unit').each(function(_,e){s[$(e).text()]=1;n++;});" +
            "var k=[];for(var x in s)k.push(x);return k.length===1?k[0]+' x'+n:'MIXED: '+k.join('|');})()";
        r.check('starts in inches', await b.evaluate("$(\"input:checked[name='units']\").val()") === 'in');
        r.check('every unit label agrees', await b.evaluate(spans) === 'in x26', await b.evaluate(spans));

        await b.evaluate('window.__draws=0;var _d=ff.drawGuitar;ff.drawGuitar=function(){window.__draws++;return _d.apply(this,arguments);};');
        await b.evaluate("document.querySelector(\"input[name='units'][value='mm']\").click()");
        r.check('switching units redraws exactly once', await b.evaluate('window.__draws') === 1, await b.evaluate('window.__draws'));
        for (const [id, want] of [['len', '635'], ['nutWidth', '34.925'], ['bridgeWidth', '53.975'], ['oE', '2.38125']]) {
            r.check(`${id} converted to ${want}`, await b.evaluate(`$('#${id}').val()`) === want, await b.evaluate(`$('#${id}').val()`));
        }
        r.check('unit labels follow', await b.evaluate(spans) === 'mm x26', await b.evaluate(spans));
        r.check('tables are labelled mm', String(await b.evaluate("$('#tables').html()")).indexOf('length (mm)') > -1);
        r.check('the degree entity renders as a degree sign', String(await b.evaluate("$('#tables').text()")).indexOf('angle (°)') > -1);
        r.check('no mojibake in the tables', String(await b.evaluate("$('#tables').text()")).indexOf('Â') === -1);

        // fields inside hidden alternatives convert too, or switching mode later mixes units
        r.check('hidden lenF converted', await b.evaluate("$('#lenF').val()") === '635');
        r.check('hidden lenL converted', await b.evaluate("$('#lenL').val()") === '711.2');
        r.check('all eight hidden overhangs converted', await b.evaluate(
            "['oN','oB','oL','oF','oNL','oNF','oBL','oBF'].every(function(i){return $('#'+i).val()==='2.38125';})"));

        // ratios, counts and tuning are not lengths
        for (const [id, want] of [['pDist', '0.5'], ['ipDist', '0.5'], ['numFrets', '24'], ['numStrings', '6'], ['root', '12']]) {
            r.check(`${id} left untouched`, await b.evaluate(`$('#${id}').val()`) === want, await b.evaluate(`$('#${id}').val()`));
        }
        r.check('tuning left untouched', await b.evaluate("ff.getTuning('tuning').join(',')") === '0,0,0,0,0,0');

        await b.evaluate("document.querySelector(\"input[name='units'][value='in']\").click()");
        r.check('round-trip back to inches is exact', await b.evaluate(
            "$('#len').val()==='25' && $('#nutWidth').val()==='1.375' && $('#oE').val()==='0.09375' && $('#lenL').val()==='28'"));
        await b.evaluate("document.querySelector(\"input[name='units'][value='cm']\").click()");
        r.check('centimetres convert too', await b.evaluate(
            "$('#len').val()==='63.5' && $('#nutWidth').val()==='3.4925' && $('#oE').val()==='0.238125'"));

        // gauges and regenerated per-string defaults
        await b.load(b.appUrl());
        await b.evaluate("$('#proportional').click();$('#igauges > input').each(function(i,e){$(e).val([0.010,0.013,0.017,0.026,0.036,0.046][i]);});");
        await b.evaluate("document.querySelector(\"input[name='units'][value='mm']\").click()");
        r.check('string gauges convert', await b.evaluate("getGauges('igauges').join(',')") === '0.254,0.3302,0.4318,0.6604,0.9144,1.1684',
            await b.evaluate("getGauges('igauges').join(',')"));
        await b.evaluate("$('#individual').click();$('#numStrings').val('7').change();");
        // the LAST entry is the newly generated one; index 0 is a pre-existing
        // value that was already converted, so it passes either way
        r.check('regenerated per-string defaults follow the unit',
            await b.evaluate("getLengths('ilengths')[6]") === 711.2,
            await b.evaluate("JSON.stringify(getLengths('ilengths'))"));

        // ------------------------------------------------------------ the help links

        await b.load(b.appUrl());
        r.check('the units group has a [?] link', await b.evaluate(
            "$('#worksheet > dd').filter(function(){return $(this).text().indexOf('units')===0;}).first().find('a.help').length") === 1);
        await b.evaluate("$('#worksheet > dd').filter(function(){return $(this).text().indexOf('units')===0;}).first().find('a.help').click()");
        r.check('it opens the units help block', await b.evaluate(
            "(function(){var d=$('#worksheet > dd').filter(function(){return $(this).text().indexOf('units')===0;}).first().next().next();" +
            "return d.hasClass('help') && d.css('display')==='block';})()"));
        // a different link, because clicking the same one again just closes it
        await b.evaluate("$('#worksheet > dt').filter(function(){return $(this).text().indexOf('string width at the nut')===0;}).first().find('a.help').click()");
        r.check('a pre-existing [?] still targets its own block', await b.evaluate(
            "(function(){var d=$('#worksheet > dt').filter(function(){return $(this).text().indexOf('string width at the nut')===0;}).first().next().next();" +
            "return d.hasClass('help') && d.css('display')==='block' && d.text().indexOf('distance along the nut')>-1;})()"));

        // --------------------------------------------------------------- permalinks

        await b.load(b.appUrl());
        const link = await b.evaluate("document.querySelector(\"input[name='units'][value='mm']\").click();$('#len').val('700').change();$('#bookmark').attr('href')");
        r.check('a permalink is generated', typeof link === 'string' && link.indexOf('len=700') > -1, link);
        await b.load(link);
        r.check('a mm permalink restores in mm, not reconverted', await b.evaluate(
            "$(\"input:checked[name='units']\").val()==='mm' && $('#len').val()==='700' && $('#nutWidth').val()==='34.925'"),
            await b.evaluate("$('#len').val()"));

        // a legacy link written before units were converted must restore untouched
        await b.load(b.appUrl('#len=24.75&nutWidth=1.375&bridgeWidth=2.125&oE=0.09375&numFrets=22&numStrings=6'));
        r.check('a legacy inch permalink restores untouched', await b.evaluate(
            "$(\"input:checked[name='units']\").val()==='in' && $('#len').val()==='24.75' && $('#numFrets').val()==='22'"));
        // arrays survive the round trip
        await b.load(b.appUrl('#t[]=0&t[]=7&t[]=3&t[]=10&t[]=5&t[]=0&numStrings=6'));
        r.check('the tuning array restores from the fragment', await b.evaluate("ff.getTuning('tuning').join(',')") === '0,7,3,10,5,0',
            await b.evaluate("ff.getTuning('tuning').join(',')"));

        // display checkboxes: .val() on a checkbox is "on" whether ticked or not,
        // so serializing that made every link identical and lost the choices
        await b.load(b.appUrl());
        await b.evaluate("document.getElementById('showStrings').click();document.getElementById('showBoundingBox').click()");
        const optsBefore = await b.evaluate('JSON.stringify(getDisplayOptions())');
        const optsLink = await b.evaluate("$('#bookmark').attr('href')");
        r.check('toggling a display option changes the link', optsLink.indexOf('showStrings=0') > -1 && optsLink.indexOf('showBoundingBox=1') > -1,
            (/showStrings=[^&]*/.exec(optsLink) || []) + ' ' + (/showBoundingBox=[^&]*/.exec(optsLink) || []));
        await b.load(optsLink);
        r.check('display options survive the permalink', await b.evaluate('JSON.stringify(getDisplayOptions())') === optsBefore,
            await b.evaluate('JSON.stringify(getDisplayOptions())'));
        // links written before that fix carry "on" for all five regardless of
        // state; obeying them would switch on options the author never chose
        await b.load(b.appUrl('#showStrings=on&showBoundingBox=on&extendFrets=on'));
        r.check('a legacy "on" checkbox value is ignored, not obeyed', await b.evaluate(
            "(function(){var o=getDisplayOptions();return o.showStrings===true&&o.showBoundingBox===false&&o.extendFrets===false;})()"),
            await b.evaluate('JSON.stringify(getDisplayOptions())'));

        // the alternative tab ids are not unique: "equal" is both a spacing mode
        // and an overhang mode, so a document-wide lookup hit the wrong group
        await b.load(b.appUrl());
        await b.evaluate("$('#proportional').click()");
        const altLink = await b.evaluate("$('#bookmark').attr('href')");
        await b.load(altLink);
        r.check('proportional spacing survives a permalink whose overhang is "equal"',
            await b.evaluate("ff.getAlt('spacing')") === 'proportional' && await b.evaluate("ff.getAlt('overhang')") === 'equal',
            await b.evaluate("ff.getAlt('spacing')+'/'+ff.getAlt('overhang')"));
        // and every alternative group round-trips together
        await b.load(b.appUrl());
        await b.evaluate("$('#multiple').click();$('#proportional').click();$('#scala').click();$('#firstlast').click()");
        const allAlts = await b.evaluate("$('#bookmark').attr('href')");
        await b.load(allAlts);
        r.check('all four alternative groups round-trip', await b.evaluate(
            "['length','spacing','scale','overhang'].map(function(g){return ff.getAlt(g);}).join(',')") === 'multiple,proportional,scala,firstlast',
            await b.evaluate("['length','spacing','scale','overhang'].map(function(g){return ff.getAlt(g);}).join(',')"));

        // jQuery 1.x's $.param wrote spaces as +, 3.x writes %20. Old links must
        // still decode: #scl is the only field that can hold a space.
        await b.load(b.appUrl('#scale=scala&scl=' + encodeURIComponent('! t.scl\nmy scale here\n1\n2/1').replace(/%20/g, '+')));
        r.check('a legacy +-encoded space still decodes', String(await b.evaluate("$('#scl').val()")).indexOf('my scale here') > -1,
            JSON.stringify(await b.evaluate("$('#scl').val()")));

        await b.load(b.appUrl('#u=furlong&len=24.75&nutWidth=1.375'));
        r.check('an unknown unit falls back to inches', await b.evaluate("$(\"input:checked[name='units']\").val()") === 'in');
        await b.evaluate("document.querySelector(\"input[name='units'][value='mm']\").click()");
        r.check('and converting afterwards still yields numbers', await b.evaluate("$('#len').val()") === '628.65', await b.evaluate("$('#len').val()"));

        // ---------------------------------------------------------- script injection

        for (const [name, hash, sel] of [
            ['tuning', `#t[]=${PAYLOAD}&numStrings=6`, '#tuning img'],
            ['individual lengths', `#il[]=${PAYLOAD}`, '#ilengths img'],
            ['string gauges', `#ig[]=${PAYLOAD}`, '#igauges img'],
        ]) {
            await b.load(b.appUrl(hash));
            r.check(`${name}: nothing injected`, await b.evaluate(`document.querySelectorAll('${sel}').length`) === 0);
            r.check(`${name}: no script ran`, await b.evaluate('window.__pwned || false') === false);
        }
        await b.load(b.appUrl('#sl=' + encodeURIComponent('<img src=x onerror="window.__pwned2=1">')));
        r.check('alternative-tab id: no script ran', await b.evaluate('window.__pwned2 || false') === false);
        r.check('alternative-tab id: page still works', Number(await b.evaluate("$('#tables').html().length")) > 0);

        // ------------------------------------------------------------- invalid input

        await b.load(b.appUrl('#root=0'));
        r.check('a zero tone count does not throw', await noErrors(), await errs());
        r.check('it shows an error instead', await b.evaluate("$('#errors').css('display')") === 'block');
        r.check('the message names the problem', String(await b.evaluate("$('#errors').text()")).indexOf('positive number') > -1);
        await b.evaluate("$('#root').val('12').change()");
        r.check('fixing the input clears the error', await b.evaluate("$('#errors').css('display')") === 'none');
        r.check('and the tables come back', String(await b.evaluate("$('#tables').html()")).indexOf('String 6 Frets') > -1);

        await b.load(b.appUrl('#scale=scala&scl=' + encodeURIComponent('! x\ntitle\n5\n100.\n200.')));
        r.check('a malformed scala file is reported', await b.evaluate("$('#errors').css('display')") === 'block');
        r.check('and does not throw', await noErrors(), await errs());

        for (const [value, label] of [['0', 'zero'], ['1', 'one'], ['', 'blank'], ['abc', 'non-numeric']]) {
            await b.load(b.appUrl());
            await b.evaluate(`$('#numStrings').val('${value}').change()`);
            r.check(`numStrings "${label}" does not throw`, await noErrors(), await errs());
        }
        await b.load(b.appUrl());
        await b.evaluate("$('#numStrings').val('1').change()");
        r.check('one string yields exactly one string', (String(await b.evaluate("$('#tables').html()")).match(/String \d+ Frets/g) || []).length === 1);
        r.check('one string stays finite and centred', await b.evaluate(
            "(function(){var g=getGuitar();return isFinite(g.edge1.end1.x)&&Math.abs(g.strings[0].end1.x-g.center)<1e-9;})()"));

        await b.load(b.appUrl());
        await b.evaluate("$('#individual').click();$('#ilengths > input').each(function(_,e){$(e).val('0.1');});$('#ilengths > input').first().change();");
        r.check('an impossible scale length is reported', await b.evaluate("$('#errors').css('display')") === 'block');
        r.check('and does not throw', await noErrors(), await errs());

        // ------------------------------------------------------------ global hygiene

        await b.load(b.appUrl());
        for (const name of ['x', 'y', 'output', 'j', 'num', 'half_adjacent_strings', 'next_space']) {
            r.check(`nothing leaks window.${name}`, await b.evaluate(`typeof window.${name}`) === 'undefined');
        }
        r.check('no broken images', await b.evaluate(
            'Array.prototype.slice.call(document.images).filter(function(i){return i.naturalWidth===0;}).length') === 0);
        r.check('the default page is clean', await noErrors(), await errs());

        // ------------------------------------------------------------ the drawing

        // drawGuitar has no other coverage. It concatenates every segment of a
        // kind into a single path, so the default view is exactly five: strings,
        // metas, edges, nut+bridge, and all the fretlets.
        r.check('the diagram is a real svg', await b.evaluate("document.querySelectorAll('#diagram svg').length") === 1);
        const shapes = () => b.evaluate("document.querySelectorAll('#diagram path, #diagram rect').length");
        r.check('the default view draws five paths', await shapes() === 5, await shapes());
        // and the display options really reach the renderer
        await b.evaluate("document.getElementById('extendFrets').click()");
        r.check('extending frets adds a path', await shapes() === 6, await shapes());
        await b.evaluate("document.getElementById('showBoundingBox').click()");
        r.check('the bounding box adds a rect', await shapes() === 7, await shapes());
        await b.evaluate("document.getElementById('showStrings').click()");
        r.check('hiding the strings removes a path', await shapes() === 6, await shapes());
        await b.evaluate("document.getElementById('showMetas').click()");
        r.check('hiding the metas removes another', await shapes() === 5, await shapes());
        // the fretlet path really contains one subpath per fretlet
        const moves = await b.evaluate(
            "(function(){var d=Array.prototype.slice.call(document.querySelectorAll('#diagram path'))" +
            ".map(function(p){return p.getAttribute('d')||'';}).join('');return (d.match(/M/gi)||[]).length;})()");
        r.check('the paths carry a subpath per drawn segment', moves >= 150, moves);

        // ------------------------------------------------------------- the writers

        await b.load(b.appUrl());
        await b.evaluate("document.querySelector(\"input[name='units'][value='mm']\").click()");
        const writers = await b.evaluate(`(function(){
            var g = ff.fretGuitar(getGuitar()), o = getDisplayOptions(), out = {};
            var probe = function(name, fn){ try { var v = fn(); out[name] = v && (v.size || v.length) || 0; }
                                            catch (e) { out[name] = 'THREW: ' + e.message; } };
            probe('SVG', function(){ return ff.getSVG(g,o); });
            probe('DXF', function(){ return ff.getDXF(g,o); });
            probe('CSV', function(){ return ff.getCSV(g); });
            probe('TAB', function(){ return ff.getTAB(g); });
            probe('HTML', function(){ return ff.getHTML(g); });
            probe('PDF', function(){ return ff.getPDF(g,o); });
            probe('PDFMultipage', function(){ return ff.getPDFMultipage(g,o,'letter'); });
            return out;
        })()`);
        for (const [name, size] of Object.entries(writers || {})) {
            r.check(`${name} produces output in mm`, typeof size === 'number' && size > 100, size);
        }

        // ------------------------------------------------------------------ pdf
        //
        // The point of the PDF output is printing at true physical size, so the
        // assertion that matters is the page box. A design is the same physical
        // object however its numbers are written, so the MediaBox must come out
        // identical in inches, centimetres and millimetres.

        const readPdf = (call) => b.evaluate(`(function(){
            var g = ff.fretGuitar(getGuitar());
            var blob = ${call};
            return new Promise(function(resolve){
                var reader = new FileReader();
                reader.onload = function(){
                    var text = reader.result;
                    var box = (/MediaBox\\s*\\[([^\\]]*)\\]/.exec(text)||[])[1] || '';
                    resolve({
                        isBlob: blob instanceof Blob, type: blob.type, size: blob.size,
                        box: box.trim().split(/\\s+/).map(parseFloat),
                        pages: (text.match(/\\/Type\\s*\\/Page[^s]/g)||[]).length
                    });
                };
                reader.readAsBinaryString(blob);
            });
        })()`);

        const boxes = {};
        for (const unit of ['in', 'cm', 'mm']) {
            await b.load(b.appUrl());
            await b.evaluate(`document.querySelector("input[name='units'][value='${unit}']").click()`);
            const pdf = await readPdf('ff.getPDF(g, getDisplayOptions())');
            boxes[unit] = pdf.box;
            r.check(`${unit}: getPDF returns a pdf Blob`, pdf.isBlob && pdf.type === 'application/pdf', `${pdf.isBlob} ${pdf.type}`);
            r.check(`${unit}: it is a single page`, pdf.pages === 1, pdf.pages);
            // 3.3125 x 26 inches at 72 points per inch
            r.check(`${unit}: page box is 238.5 x 1872 points`,
                Math.abs(pdf.box[2] - 238.5) < 0.01 && Math.abs(pdf.box[3] - 1872) < 0.01, pdf.box.join(' '));
        }
        r.check('the printed size is identical in all three units',
            Math.abs(boxes.in[2] - boxes.mm[2]) < 0.01 && Math.abs(boxes.in[3] - boxes.cm[3]) < 0.01,
            JSON.stringify(boxes));

        // jsPDF 3 reorders format to match orientation -- portrait forces
        // height >= width -- so a design wider than it is long used to come out
        // rotated, with the drawing running off the edge of the paper
        await b.load(b.appUrl());
        await b.evaluate("$('#len').val('2');$('#nutWidth').val('10');$('#bridgeWidth').val('12');$('#len').change();");
        const wide = await readPdf('ff.getPDF(g, getDisplayOptions())');
        // 12.1875 + 1 wide by 2 + 1 long, at 72 points per unit
        r.check('a design wider than it is long keeps its page orientation',
            Math.abs(wide.box[2] - 949.5) < 0.01 && Math.abs(wide.box[3] - 216) < 0.01, wide.box.join(' '));

        await b.load(b.appUrl());
        const multi = await readPdf("ff.getPDFMultipage(g, getDisplayOptions(), 'letter')");
        r.check('multipage uses real letter pages (612 x 792 points)',
            Math.abs(multi.box[2] - 612) < 0.01 && Math.abs(multi.box[3] - 792) < 0.01, multi.box.join(' '));
        // 25in tall over a 10in printable height, 2.3125in wide over 7.5in
        r.check('multipage tiles the design across three pages', multi.pages === 3, multi.pages);

        // ------------------------------------------------------------- downloads
        //
        // The one path with no other coverage: Blob construction, FileSaver, and
        // the click handlers. Downloads are captured to a temp directory so the
        // bytes that would reach disk can actually be inspected.

        const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'fretfind-dl-'));
        await b.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true });
        await b.load(b.appUrl());
        const buttons = [
            ['download_dxf', 'fretboard.dxf', '999'],
            ['download_svg', 'fretboard.svg', '<svg'],
            ['download_csv', 'fretboard.csv', '"Midline"'],
            ['download_tab', 'fretboard.tab', 'Midline'],
            ['download_html', 'fretboard.html', '<html>'],
            ['download_pdf', 'fretboard.pdf', '%PDF-'],
            ['download_pdfm', 'fretboard.pdf', '%PDF-'],
        ];
        // an invalid form must not produce a file: the text writers used to emit
        // NaN-filled ones, and jsPDF 3 throws, so the PDF buttons died silently
        await b.load(b.appUrl('#root=0'));
        for (const id of ['download_dxf', 'download_pdf', 'download_csv']) {
            let outcome = 'no file';
            try { outcome = 'wrote ' + await b.download(() => b.evaluate(`document.getElementById('${id}').click()`), 4000); }
            catch (e) { outcome = e.message; }
            r.check(`${id} refuses to write a file from invalid input`, outcome === 'download timed out', outcome);
        }
        r.check('and the error is shown instead', await b.evaluate("$('#errors').css('display')") === 'block');
        r.check('no uncaught error from any download button', await noErrors(), await errs());

        await b.load(b.appUrl());
        for (const [id, filename, magic] of buttons) {
            r.check(`${id} button exists`, await b.evaluate(`document.querySelectorAll('#${id}').length`) === 1);
            let saved = null;
            let error = '';
            try {
                saved = await b.download(() => b.evaluate(`document.getElementById('${id}').click()`));
            } catch (e) { error = e.message; }
            if (!saved) { r.check(`${id} writes ${filename}`, false, error); continue; }
            const bytes = fs.readFileSync(saved);
            r.check(`${id} writes a non-trivial ${filename}`, bytes.length > 500, bytes.length + ' bytes');
            r.check(`${id} content starts with ${JSON.stringify(magic)}`,
                bytes.subarray(0, 16).toString('latin1').startsWith(magic),
                JSON.stringify(bytes.subarray(0, 16).toString('latin1')));
            r.check(`${id} is named ${filename}`, path.basename(saved) === filename, path.basename(saved));
        }
        fs.rmSync(downloads, { recursive: true, force: true });

        // --------------------------------------------------------------- geom.html

        await b.load(b.url('/test/geom.html'), "document.readyState==='complete'");
        const geom = await b.evaluate("JSON.stringify({good:document.querySelectorAll('.good').length,bad:document.querySelectorAll('.bad').length})");
        const g = JSON.parse(geom);
        r.check(`geom.html: ${g.good} green, ${g.bad} red`, g.bad === 0 && g.good === 27, geom);
    } finally {
        await b.close();
    }

    process.exitCode = r.print() ? 1 : 0;
})();
