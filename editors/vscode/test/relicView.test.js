// Tests for the Relic Editor's view (media/relicView.js).
// Run: npm run test:view   (or: node test/relicView.test.js)
//
// The view is a pure function - model in, HTML out - which is the only half of this
// editor a unit test can reach. It exists as its own module for exactly that reason:
// while it lived inside extension.ts it had never produced a single character of output,
// and it was shipping three bugs that a one-line render check would have caught.
//
// What these tests CANNOT tell you: whether the plan looks right, whether a drag feels
// right, or whether the panel is usable. That needs an Extension Development Host and an
// eye.
const R = require('../media/relicModel.js');
const V = require('../media/relicView.js');

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

const html = V.render(R.parse(DOC).relics, 'NONCE', 0);

// The failure mode that actually happened: a part with no draw position rendered
// cx="undefined" and silently vanished. Assert the absence of both spellings of broken.
// Only the MARKUP is checked, not the inline script - which legitimately contains the
// word `undefined` in a guard. The failure this guards against is an attribute VALUE
// like cx="undefined", which is what made every solid invisible once.
const markup = html.slice(0, html.indexOf('<script'));
check('produces a document', html.indexOf('<!DOCTYPE html>') === 0);
check('no undefined leaked into an attribute', markup.indexOf('undefined') < 0);
check('no NaN leaked into an attribute', markup.indexOf('NaN') < 0);

check('a chamber draws at its authored coordinates',
  html.indexOf('cx="0" cy="0" r="900"') >= 0);
check('...and so does its neighbour', html.indexOf('cx="3000" cy="0" r="700"') >= 0);
check('a box draws as a rect at centre minus half-extents',
  // z=2900 with hz=380: sy(2900) is -2900, so the top edge is -3280. The pre-flip
  // expectation here was 2520, which is exactly the mirrored answer.
  html.indexOf('<rect x="2700" y="-3280" width="1800" height="760"') >= 0);
check('a passage joins the two chambers',
  html.indexOf('x1="3000"') >= 0 && html.indexOf('x2="0"') >= 0);
check('a subtracted solid is dashed, so it reads as not-room',
  html.indexOf('stroke-dasharray') >= 0);

check('every part is draggable', (html.match(/class="part"/g) || []).length === 4);
check('the CSP nonce is wired', html.indexOf("script-src 'nonce-NONCE'") >= 0);
check('SVG user units are world units (viewBox frames the relic)',
  /viewBox="-?\d+ -?\d+ \d+ \d+"/.test(html));

// A relic-free file must say so rather than render an empty frame.
check('an empty model explains itself',
  V.render([], 'N', 0).indexOf('No relic in this file') >= 0);

// --------------------------------------------------------- the 2D limitation
// A capsule along Y is a vertical shaft. On a top-down plan its endpoints coincide, so it
// projects to a DOT - a zero-length line with round caps. That is the honest consequence
// of a 2D plan with height as a label, not a bug, and it is worth pinning so nobody
// "fixes" it into something misleading.
const VERT = ['### [O](o)', '---', 'Loc: 0,0,0', '---', '',
  '### [spine](spine)', '---', 'Relic: o',
  'Solid: capsule, 0, -2100, 0, 0, 2100, 0, 130', '---'].join(NL);
const vh = V.render(R.parse(VERT).relics, 'N', 0);
check('a vertical capsule projects to a point on the plan',
  vh.indexOf('x1="0" y1="0" x2="0" y2="0"') >= 0);
check('...drawn with round caps so it still reads as a disc',
  vh.indexOf('stroke-linecap="round"') >= 0);

const HORIZ = ['### [O](o)', '---', 'Loc: 0,0,0', '---', '',
  '### [bar](bar)', '---', 'Relic: o',
  'Solid: capsule, -800, 0, 0, 800, 0, 0, 130', '---'].join(NL);
check('a capsule across the plan draws as a real line',
  V.render(R.parse(HORIZ).relics, 'N', 0).indexOf('x1="-800" y1="0" x2="800" y2="0"') >= 0);

// ------------------------------------------------------------------ safety
const NASTY = ['### [O](o)', '---', 'Loc: 0,0,0', '---', '',
  '### [<script>alert(1)</script>](x)', '---', 'Relic: o',
  'Chamber: 0, 0, 0, 100', '---'].join(NL);
check('a name cannot inject markup',
  V.render(R.parse(NASTY).relics, 'N', 0).indexOf('<script>alert(1)</script>') < 0);

const ORPHAN = DOC.replace('Relic: oss' + NL + 'Chamber: 3000, 0, 0, 700',
                           'Relic: typo' + NL + 'Chamber: 3000, 0, 0, 700');
check('an orphaned part is reported rather than silently missing',
  V.render(R.parse(ORPHAN).relics, 'N', 0).indexOf('name a relic that does not exist') >= 0);


// ------------------------------------------------- vertical stacks and labels
// A top-down plan cannot show a vertical stack: a shaft directly above a hub is the SAME
// DOT. Before this, their names and readouts printed on top of each other and came out as
// mush - "shalft", "galtrex" - which is only visible on screen, so it survived every
// earlier test.
const STACK = ['### [O](o)', '---', 'Loc: 0,0,0', '---', '',
  '### [hub](hub)', '---', 'Relic: o', 'Chamber: 0, 0, 0, 900', '---', '',
  '### [shaft](shaft)', '---', 'Relic: o', 'Chamber: 0, 2200, 0, 600', '---', '',
  '### [pit](pit)', '---', 'Relic: o', 'Chamber: 0, -1800, 0, 500', '---'].join(NL);
const srel = R.parse(STACK).relics[0];
const srows = V.stackRows(srel.chambers);

check('co-located parts are detected as a stack',
  srows.get('hub').of === 3 && srows.get('shaft').of === 3);
check('the stack is ordered by height, tallest first',
  srows.get('shaft').row === 0 && srows.get('hub').row === 1 && srows.get('pit').row === 2);

const sh = V.render([srel], 'N', 0);
const dys = (sh.match(/text-anchor="middle" dy="(-?[\d.]+)"/g) || [])
  .map((t) => t.match(/dy="(-?[\d.]+)"/)[1]);
check('every label row gets a distinct offset',
  new Set(dys).size === dys.length);
check('a stacked part gets a leader line back to its dot',
  (sh.match(/stroke-opacity="0.35"/g) || []).length === 3);

// A part standing on its own must NOT get a leader line - that would be visual noise on
// every plan that has no stacking at all.
const LONE = ['### [O](o)', '---', 'Loc: 0,0,0', '---', '',
  '### [hub](hub)', '---', 'Relic: o', 'Chamber: 0, 0, 0, 900', '---'].join(NL);
check('a lone chamber has no leader line',
  V.render(R.parse(LONE).relics, 'N', 0).indexOf('stroke-opacity="0.35"') < 0);



// ------------------------------------------------------------ grid, pan, zoom
// The grid is a RULER, so its spacing has to be a number you can count in - 1000 minor,
// 10000 major, the game's own 2D view spacing. Arbitrary spacing would make it decoration.
check('minor spacing is 1000', V.GRID_MINOR === 1000);
check('major spacing is 10000', V.GRID_MAJOR === 10000);
check('lines land on round world coordinates',
  V.gridLines(-4100, 6100, 1000)[0] === -4000);
check('a line is emitted per step across the span',
  V.gridLines(0, 5000, 1000).length === 6);
check('an absurd span emits nothing rather than solid ink',
  V.gridLines(0, 10000000, 1000).length === 0);

const gh = V.render(R.parse(DOC).relics, 'N', 0);
check('the grid is drawn', gh.indexOf('class="grid"') >= 0);
check('the grid never eats a mouse gesture', gh.indexOf('pointer-events="none"') >= 0);
check('major lines are drawn heavier than minor',
  gh.indexOf('stroke-opacity="0.30"') >= 0 && gh.indexOf('stroke-opacity="0.10"') >= 0);
check('the header says what the spacing is', gh.indexOf('grid 1k, bold 10k') >= 0);

// The view must survive a redraw. The panel redraws on EVERY document change, so without
// this a single keystroke would throw away your zoom and pan.
const VIEW = { x: 100, y: 200, w: 3000, h: 1500 };
const vh2 = V.render(R.parse(DOC).relics, 'N', 0, VIEW);
check('a supplied view is honoured', vh2.indexOf('viewBox="100 200 3000 1500"') >= 0);
check('no view falls back to the relic bounds',
  V.render(R.parse(DOC).relics, 'N', 0).indexOf('viewBox="100 200 3000 1500"') < 0);
check('a nonsense view is ignored rather than blanking the panel',
  V.render(R.parse(DOC).relics, 'N', 0, { x: 0, y: 0, w: 0, h: 0 })
    .indexOf('viewBox="0 0 0 0"') < 0);
check('the view is reported back so the panel can restore it',
  gh.indexOf("type:'view'") >= 0);

check('dragging the background pans, dragging a part moves it',
  gh.indexOf("e.target.closest('.part')") >= 0 && gh.indexOf('panning') >= 0);
check('the wheel zooms about the cursor',
  gh.indexOf("addEventListener('wheel'") >= 0);
check('double-click resets, as the game radar does',
  gh.indexOf("addEventListener('dblclick'") >= 0);



// ------------------------------------------------------------- +Z is UP
// The game's radar projects `toY: wz => cyp - (wz - cz) * scale` - "+Z up" - while SVG's
// y axis grows DOWNWARD. Getting this backwards mirrors the whole relic, which looks
// entirely plausible and is wrong: a chamber authored north of the hub sits south of it.
check('world z maps through sy as a negation', V.sy(2000) === -2000 && V.sy(-500) === 500);

const NS = ['### [O](o)', '---', 'Loc: 0,0,0', '---', '',
  '### [north](north)', '---', 'Relic: o', 'Chamber: 0, 0, 2000, 300', '---', '',
  '### [south](south)', '---', 'Relic: o', 'Chamber: 0, 0, -2000, 300', '---'].join(NL);
const nsh = V.render(R.parse(NS).relics, 'N', 0);
check('a chamber at +Z draws ABOVE the origin',
  nsh.indexOf('cx="0" cy="-2000" r="300"') >= 0);
check('a chamber at -Z draws BELOW the origin',
  nsh.indexOf('cx="0" cy="2000" r="300"') >= 0);

// The webview must hand back WORLD deltas, so the model never sees screen space.
check('the drag negates dz on its way out',
  nsh.indexOf('dz:-drag.dz') >= 0);

// A box straddles its centre, so the flip must not shift it half its own height.
const BOXNS = ['### [O](o)', '---', 'Loc: 0,0,0', '---', '',
  '### [hall](hall)', '---', 'Relic: o', 'Box: 0, 0, 1000, 500, 100, 200', '---'].join(NL);
check('a box stays centred through the flip',
  V.render(R.parse(BOXNS).relics, 'N', 0).indexOf('y="-1200"') >= 0);



// ----------------------------------------------------------- the inspector
// Dragging is for ARRANGING; typing is for meaning it. A radius of exactly 900 or a
// height of exactly 2200 cannot be dragged to, so the numbers need a form.
check('the inspector exists and starts hidden',
  markup.indexOf('id="insp"') >= 0 && markup.indexOf('insp hidden') >= 0);
check('a chamber carries its numbers for the form to read',
  markup.indexOf('data-x="0"') >= 0 && markup.indexOf('data-r="900"') >= 0);
check('height is carried too - the plan cannot show it',
  markup.indexOf('data-y=') >= 0);
check('a box carries half-extents instead of a radius',
  markup.indexOf('data-hx="900"') >= 0 && markup.indexOf('data-hz="380"') >= 0);
check('a solid carries its shape, so the form can label it',
  markup.indexOf('data-shape="sphere"') >= 0);
check('the form commits on change, not on every keystroke',
  html.indexOf("addEventListener('change'") >= 0);
check('selecting opens the inspector, clicking away closes it',
  html.indexOf('show(g)') >= 0 && html.indexOf('show(null)') >= 0);
check('the form posts a patch, not a whole record',
  html.indexOf("type:'field'") >= 0 && html.indexOf('patch:patch') >= 0);



// ------------------------------------------------------ add, delete, connect
check('the toolbar offers add and delete',
  markup.indexOf('id="add"') >= 0 && markup.indexOf('id="del"') >= 0);
check('SHIFT-drag is what connects, and the header says so',
  html.indexOf('e.shiftKey') >= 0 && markup.indexOf('SHIFT-drag') >= 0);
check('a link posts from and to', html.indexOf("type:'link'") >= 0);
check('a solid cannot be a passage endpoint - it is not a room',
  html.indexOf("t.dataset.kind!=='solid'") >= 0);
check('Delete and Backspace both remove the selection',
  html.indexOf("e.key==='Delete'") >= 0 && html.indexOf("e.key==='Backspace'") >= 0);
check('...but not while typing a number into the form',
  html.indexOf("e.target.tagName==='INPUT'") >= 0);
check('a new chamber lands in the middle of the current view',
  html.indexOf('vb.x+vb.w/2') >= 0);
check('...with its z un-flipped on the way out',
  html.indexOf('0-(vb.y+vb.h/2)') >= 0);



// ------------------------------------------------------------ live preview
check('the toolbar offers Preview', markup.indexOf('id="prev"') >= 0);
check('Preview posts to the extension, not straight to a socket',
  html.indexOf("type:'preview'") >= 0);

// ------------------------------------------------------------------- undo
// There is deliberately NO undo machinery here. Every edit goes through
// vscode.workspace.applyEdit, so it lands on the document's own undo stack and Ctrl+Z
// works - a second undo system would fight the first and lose.
check('the view posts intents and never edits text itself',
  html.indexOf('applyEdit') < 0 && html.indexOf('workspace') < 0);


console.log('');
if (failures) { console.log(failures + ' failure(s)'); process.exit(1); }
console.log('all relic view tests passed');
