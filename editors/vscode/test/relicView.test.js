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
check('produces a document', html.indexOf('<!DOCTYPE html>') === 0);
check('no undefined leaked into the markup', html.indexOf('undefined') < 0);
check('no NaN leaked into the markup', html.indexOf('NaN') < 0);

check('a chamber draws at its authored coordinates',
  html.indexOf('cx="0" cy="0" r="900"') >= 0);
check('...and so does its neighbour', html.indexOf('cx="3000" cy="0" r="700"') >= 0);
check('a box draws as a rect at centre minus half-extents',
  html.indexOf('<rect x="2700" y="2520" width="1800" height="760"') >= 0);
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


console.log('');
if (failures) { console.log(failures + ' failure(s)'); process.exit(1); }
console.log('all relic view tests passed');
