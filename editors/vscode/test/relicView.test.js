// Tests for the Relic Editor's PAGE (media/relicView.js).
// Run: npm run test:view   (or: node test/relicView.test.js)
//
// The view is a pure function - model in, HTML out - which is the only half of this
// editor a unit test can reach. It exists as its own module for exactly that reason:
// while it lived inside extension.ts it had never produced a single character of output,
// and it was shipping three bugs that a one-line render check would have caught.
//
// THERE IS ONE VIEW NOW. There used to be two - a top-down plan and a 3D scene, with a
// toggle - and the plan's renderer is gone. What retired it was not tidiness: two
// renderers of the same relic have to be kept honest against each other forever, and they
// had already drifted (the over-long-passage warning existed in only one of them). Looking
// straight down reproduces the plan exactly, so the toggle was a camera angle wearing a
// button. The geometry those tests used to cover now lives in relicView3d.test.js, beside
// the geometry.
//
// What these tests CANNOT tell you: whether the scene looks right, whether a drag feels
// right, or whether the panel is usable. That needs an Extension Development Host and an
// eye.
const R = require('../media/relicModel.js');
const V = require('../media/relicView.js');
const V3 = require('../media/relicView3d.js');

let failures = 0;
function check(name, cond) {
  if (cond) { console.log('  ok  - ' + name); }
  else { console.log('  FAIL- ' + name); failures++; }
}
const NL = String.fromCharCode(10);

const DOC = [
  '## [Relics](relics)', '',
  '### [The Ossuary](oss)', '---', 'Loc: 0, 0, 0', 'Atmosphere: purple', '---', '',
  '### [hub](hub)', '---', 'Relic: oss', 'Chamber: 0, 0, 0, 900', '---', '',
  '### [gallery](gallery)', '---', 'Relic: oss', 'Chamber: 3000, 0, 0, 700',
  'Passage to: hub 300', '---', '',
  '### [hall](hall)', '---', 'Relic: oss', 'Box: 3600, 0, 2900, 900, 260, 380', '---', '',
  '### [core](core)', '---', 'Relic: oss', 'Solid: sphere, 0, 0, 0, 320', '---',
].join(NL);

const relics = R.parse(DOC).relics;
const html = V.render(relics, 'NONCE', 0);
// Only the MARKUP is checked for broken-value patterns, never the inline script - which
// legitimately contains the word `undefined` in a guard. The failure this guards against
// is an attribute VALUE like cx="undefined", which is what made every solid invisible once.
const markup = html.slice(0, html.indexOf('<script'));

console.log('');
console.log('relicView');
console.log('');

check('produces a document', html.indexOf('<!DOCTYPE html>') === 0);
check('no attribute rendered from an undefined value',
  markup.indexOf('="undefined"') < 0 && markup.indexOf('="NaN"') < 0);
check('the nonce reaches the script tag, or the CSP blocks it',
  html.indexOf('nonce="NONCE"') >= 0);
check('nothing external for the CSP to block',
  html.indexOf('http://') < 0 && html.indexOf('https://') < 0);

// ------------------------------------------------------------------ one view
check('there is one scene', markup.indexOf('id="scene3"') >= 0);
check('...and no second renderer beside it', markup.indexOf('id="plan"') < 0);
check('...and no toggle between them',
  markup.indexOf('id="m2d"') < 0 && markup.indexOf('id="m3d"') < 0);
check('the grid is there', markup.indexOf('id="grid3"') >= 0);
check('the labels are there', markup.indexOf('id="lab3g"') >= 0);
check('the navigation gizmo is there', markup.indexOf('id="navg"') >= 0);
check('the inspector is there', markup.indexOf('id="insp"') >= 0);
check('the context menu is there', markup.indexOf('id="ctx"') >= 0);
check('Add and Delete are on the toolbar',
  markup.indexOf('id="add"') >= 0 && markup.indexOf('id="del"') >= 0);
check('and the three view presets', (markup.match(/class="vw"/g) || []).length === 3);

// EVERY CONTROL IS WIRED, not merely rendered.
//
// This is the assertion that was missing. When the plan view's script was deleted with the
// plan view, Undo, Preview, Live and the relic picker lost their handlers - and the tests
// stayed green, because they asserted the BUTTONS existed. A button that renders and does
// nothing is worse than no button, and it is invisible to any check that only reads the
// markup.
const script = html.slice(html.indexOf('<script'), html.lastIndexOf('</scr' + 'ipt>'));
[['fit', "getElementById(\"fit\")"],
 ['add', "getElementById(\"add\")"],
 ['del', "getElementById(\"del\")"],
 ['undo', 'type:"undo"'],
 ['preview', 'type:"preview"'],
 ['live', 'type:"live"'],
 ['the view presets', 'querySelectorAll(".vw")'],
 ['the navigation gizmo', 'getElementById("navg")'],
 ['the context menu', 'addEventListener("contextmenu"'],
].forEach(([what, needle]) => {
  check(what + ' is wired, not just drawn', script.indexOf(needle) >= 0);
});
check('the relic picker is wired when there is more than one relic',
  V.render(R.parse(DOC + NL + NL
    + ['### [Second](two)', '---', 'Loc: 9,0,9', '---'].join(NL)).relics, 'N', 0)
    .indexOf('type:"pick"') >= 0);
// The strongest form of the same check: the page has to RUN. A ReferenceError anywhere in
// it stops every listener after the throw, which is how a single missing name has twice
// taken out a whole set of controls at once.
check('the page script runs without throwing', (() => {
  try {
    const body = script.slice(script.indexOf('>') + 1);
    new Function(body.replace('acquireVsCodeApi()', '({postMessage:function(){}})'));
    return true;
  } catch (e) { return false; }
})());

// ------------------------------------------------------------------ the shell
check('a single relic is named, not offered as a list',
  markup.indexOf('<select') < 0 && markup.indexOf('The Ossuary') >= 0);
const TWO = DOC + NL + NL + ['### [Second](two)', '---', 'Loc: 9,0,9', '---'].join(NL);
check('two relics get a picker',
  V.render(R.parse(TWO).relics, 'N', 0).indexOf('<select id="pick"') >= 0);
check('...defaulting to the one asked for',
  V.render(R.parse(TWO).relics, 'N', 1).indexOf('value="1" selected') >= 0);
check('a file with no relic says so rather than rendering an empty frame',
  V.render([], 'N', 0).indexOf('No relic in this file') >= 0);
check('an out-of-range index falls back rather than throwing',
  V.render(relics, 'N', 99).indexOf('<!DOCTYPE html>') === 0);

// Everything that starts hidden must be hidden by the SAME rule. The rule used to name
// the two elements that happened to use the class - so when the context menu arrived
// wearing it, `hidden` did nothing to it: the menu came up on right-click and stayed up,
// and the bug was in a selector nobody thought to re-read.
check('the hidden rule is general, not a list of the elements using it today',
  markup.indexOf('.hidden{display:none}') >= 0);
[['the context menu', 'id="ctx" class="ctx hidden"'],
 ['the inspector', 'id="insp" class="insp hidden"']].forEach(([what, m]) => {
  check(what + ' starts hidden', markup.indexOf(m) >= 0);
});

// ------------------------------------------------------------------ warnings
const ORPHAN = DOC + NL + NL
  + ['### [stray](stray)', '---', 'Relic: nosuch', 'Chamber: 0,0,0,100', '---'].join(NL);
check('a part naming a relic that does not exist is reported, not silently dropped',
  V.render(R.parse(ORPHAN).relics, 'N', 0).indexOf('name a relic that does not exist') >= 0);

// render-distance-objects is 5000: stand in one chamber and one further away is not drawn,
// so the corridor between them goes dark halfway. That reads as a rendering bug rather
// than a layout one, which is why the editor says it - `sbs lint` deliberately stays out
// of size judgements, and the number is a setting rather than a correctness claim.
const FAR = ['## [Relics](relics)', '',
  '### [O](o)', '---', 'Loc: 0,0,0', '---', '',
  '### [a](a)', '---', 'Relic: o', 'Chamber: 0, 0, 0, 500', 'Passage to: b 200', '---', '',
  '### [b](b)', '---', 'Relic: o', 'Chamber: 9000, 0, 0, 500', '---'].join(NL);
const farHtml = V.render(R.parse(FAR).relics, 'N', 0);
check('an over-long passage is named in the header, with its length',
  farHtml.indexOf('passage(s) longer than the 5000u render distance') >= 0
  && farHtml.indexOf('a - b (9000u)') >= 0);
check('...and drawn amber and dashed in the scene',
  farHtml.indexOf('stroke="#e0af68"') >= 0 && farHtml.indexOf('stroke-dasharray') >= 0);
check('a relic within it is unremarked', html.indexOf('passage(s) longer than') < 0);
// It is a fact about the LAYOUT, so it cannot depend on where the camera is - which is
// exactly the drift that made two renderers untenable.
check('the warning does not depend on the camera angle',
  V.render(R.parse(FAR).relics, 'N', 0, undefined, false, { yaw: 2, pitch: 0.2 })
    .indexOf('passage(s) longer than') >= 0);

// ------------------------------------------------------------------ escaping
const NASTY = ['## [Relics](relics)', '',
  '### [<script>alert(1)</script>](evil)', '---', 'Loc: 0,0,0', '---', '',
  '### [<img src=x onerror=alert(1)>](bad)', '---', 'Relic: evil',
  'Chamber: 0,0,0,100', '---'].join(NL);
const nastyHtml = V.render(R.parse(NASTY).relics, 'N', 0);
check('a name cannot inject markup through the header',
  nastyHtml.indexOf('<script>alert(1)</script>') < 0);
check('...nor through a label', nastyHtml.indexOf('<img src=x') < 0);

// ------------------------------------------------------------- remembered state
check('the live-preview toggle renders unpressed by default',
  markup.indexOf('id="live" class="on"') < 0);
check('...and pressed when the extension says it is armed',
  V.render(relics, 'N', 0, undefined, true).indexOf('id="live" class="on"') >= 0);
// A redraw fires on every keystroke in the document. Snapping back to a default framing
// mid-edit would be worse than never having remembered it.
check('a reported view is used instead of reframing',
  V.render(relics, 'N', 0, { x: 11, y: 22, w: 333, h: 444 }).indexOf('11 22 333 444') >= 0);
check('...and a nonsense one is ignored rather than trusted',
  V.render(relics, 'N', 0, { x: 0, y: 0, w: 0, h: 0 }).indexOf('viewBox="0 0 0 0"') < 0);
check('the camera is honoured when the panel supplies one',
  V.render(relics, 'N', 0, undefined, false, V3.topDown())
  !== V.render(relics, 'N', 0, undefined, false, { yaw: 1.2, pitch: 0.3 }));

// Two definitions of 5000 is one more than the number can survive.
check('the spacing and render distance are not defined twice',
  V.RENDER_DISTANCE === V3.RENDER_DISTANCE && V.span === V3.span
  && V.GRID_MINOR === V3.GRID_MINOR && V.GRID_MAJOR === V3.GRID_MAJOR);

console.log('');
console.log(failures ? failures + ' FAILED' : 'all relic view tests passed');
console.log('');
process.exit(failures ? 1 : 0);
