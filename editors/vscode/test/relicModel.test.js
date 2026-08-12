// Tests for the Relic Editor's shared model (media/relicModel.js).
// Run: npm run test:relic   (or: node test/relicModel.test.js)
//
// The property that matters is NOT "generate matches parse" - this model never
// regenerates a file. It is that an edit touches ONE LINE and leaves every other byte
// alone, so an author's prose, comments, field order and spelling survive editing.
const assert = require('assert');
const R = require('../media/relicModel.js');

const NL = String.fromCharCode(10);
let failures = 0;
function check(name, cond) {
  if (cond) { console.log('  ok  - ' + name); }
  else { console.log('  FAIL- ' + name); failures++; }
}

const DOC = [
  '# [Story](story)',
  '',
  '// a comment the editor must never eat',
  '',
  '## [Jobs](jobs)',
  '',
  '### [Sweep the belt](sweep)',
  '---',
  'Goal: clear the rocks',
  '---',
  '',
  '## [Relics](relics)',
  '',
  '### [The Ossuary](ossuary)',
  '---',
  'Loc: 12000, 0, -8000',
  'Atmosphere: purple',
  'Containment: tractor',
  '---',
  'An ancient thing, hollow, and not built by anyone still alive.',
  '',
  '### [hub](hub)',
  '---',
  'Relic: ossuary',
  'Chamber: 0, 0, 0, 900',
  '---',
  '',
  '### [gallery](gallery)',
  '---',
  'Relic: ossuary',
  'Chamber: 3000, 0, 0, 700',
  'Passage to: hub 300',
  '---',
  '',
  '### [the vault](vault)',
  '---',
  'Relic: ossuary',
  'Box: 3600, 0, 2900, 900, 260, 380',
  '---',
  '',
  '### [the core](core)',
  '---',
  'Relic: ossuary',
  'Solid: sphere, 0, 0, 0, 320',
  '---',
].join('\n');

// ---------------------------------------------------------------- parsing
const m = R.parse(DOC);
check('finds exactly one relic', m.relics.length === 1);
const rel = m.relics[0];
check('relic key and name', rel.key === 'ossuary' && rel.name === 'The Ossuary');
check('reads Loc', String(rel.loc) === String([12000, 0, -8000]));
check('a Job heading is NOT mistaken for a relic',
  !m.relics.some((r) => r.key === 'sweep'));

check('two chambers', rel.chambers.length === 2);
check('one box', rel.boxes.length === 1);
check('one solid', rel.solids.length === 1);
check('one passage', rel.passages.length === 1);

const hub = rel.chambers.find((c) => c.key === 'hub');
const gallery = rel.chambers.find((c) => c.key === 'gallery');
check('chamber numbers', hub.x === 0 && hub.r === 900 && gallery.x === 3000);
check('box half-extents', rel.boxes[0].hx === 900 && rel.boxes[0].hz === 380);
check('solid keeps its shape word', rel.solids[0].shape === 'sphere');
check('passage names its target and radius',
  rel.passages[0].to === 'hub' && rel.passages[0].radius === 300);
check('every part knows its source line', hub.line > 0 && rel.boxes[0].line > 0);

// ---------------------------------------------------------- surgical writes
const moved = R.movePart(DOC, gallery, 4200, -1500);
const before = DOC.split('\n');
const after = moved.split('\n');
check('move changes exactly one line',
  before.filter((l, i) => l !== after[i]).length === 1);
check('the changed line is the chamber', after[gallery.line].includes('Chamber:'));
check('the comment survives', moved.includes('// a comment the editor must never eat'));
check('the prose survives', moved.includes('An ancient thing, hollow'));
check('the unrelated Job survives', moved.includes('Goal: clear the rocks'));

const m2 = R.parse(moved);
const g2 = m2.relics[0].chambers.find((c) => c.key === 'gallery');
check('the move round-trips', g2.x === 4200 && g2.z === -1500);
check('the move preserved height and radius', g2.y === 0 && g2.r === 700);

// A move must not disturb its neighbours.
const h2 = m2.relics[0].chambers.find((c) => c.key === 'hub');
check('the other chamber is untouched', h2.x === 0 && h2.r === 900);

// --------------------------------------------------------------- edit kinds
const resized = R.resizePart(DOC, hub, 1250);
check('resize keeps position',
  R.parse(resized).relics[0].chambers.find((c) => c.key === 'hub').x === 0);
check('resize changes the radius',
  R.parse(resized).relics[0].chambers.find((c) => c.key === 'hub').r === 1250);

const raised = R.setHeight(DOC, hub, 2200);
const h3 = R.parse(raised).relics[0].chambers.find((c) => c.key === 'hub');
check('height edits y only', h3.y === 2200 && h3.x === 0 && h3.r === 900);

const boxMoved = R.movePart(DOC, rel.boxes[0], 1, 2);
const b2 = R.parse(boxMoved).relics[0].boxes[0];
check('a box moves and keeps its extents',
  b2.x === 1 && b2.z === 2 && b2.hx === 900 && b2.hy === 260 && b2.hz === 380);

const solidMoved = R.movePart(DOC, rel.solids[0], 500, 600);
check('a solid keeps its shape word when moved',
  solidMoved.includes('Solid: sphere, 500, 0, 600, 320'));

// ------------------------------------------------------- stability & safety
let text = DOC;
for (let i = 0; i < 5; i++) {
  const cur = R.parse(text).relics[0].chambers.find((c) => c.key === 'gallery');
  text = R.movePart(text, cur, cur.x, cur.z);       // a no-op drag
}
check('repeated no-op edits are byte-stable', text === DOC);

const bogus = R.writeField(DOC, 999, [1, 2, 3]);
check('writing past the end of the file is a no-op', bogus === DOC);
const notAField = R.writeField(DOC, 2, [1, 2, 3]);   // line 2 is the comment
check('writing to a non-field line is a no-op', notAField === DOC);

// An author's own spelling of a label is preserved rather than normalised.
const odd = DOC.replace('Chamber: 0, 0, 0, 900', 'chamber:   0, 0, 0, 900');
const oddPart = R.parse(odd).relics[0].chambers.find((c) => c.key === 'hub');
check('a lowercase label still parses', oddPart && oddPart.r === 900);
check('the author\'s label spelling survives an edit',
  R.movePart(odd, oddPart, 5, 6).includes('chamber: 5, 0, 6, 900'));

// ------------------------------------------------------------------ orphans
const ORPHAN = DOC.replace('Relic: ossuary\nChamber: 3000, 0, 0, 700',
                           'Relic: typo\nChamber: 3000, 0, 0, 700');
const om = R.parse(ORPHAN);
check('a part naming an unknown relic is kept, not dropped',
  om.relics[0].orphans.length === 1);
check('...and it is not counted as a chamber', om.relics[0].chambers.length === 1);

// ------------------------------------------------------------------- CRLF
const crlf = DOC.replace(/\n/g, '\r\n');
const cm = R.parse(crlf);
check('CRLF parses the same', cm.relics.length === 1 && cm.relics[0].chambers.length === 2);


// --------------------------------------------------------------- solids
// These exist because the first version shipped three bugs at once: solids parsed with
// x/y/z UNDEFINED (so the view emitted cx="undefined" and no solid drew at all), a
// capsule's radius read the wrong number, and dragging a capsule moved only one endpoint
// so it stretched instead of translating. The original tests missed all three by only
// ever moving a sphere and never asserting its position.
const SOLIDS = [
  '### [O](oss)', '---', 'Loc: 0, 0, 0', '---', '',
  '### [core](core)', '---', 'Relic: oss', 'Solid: sphere, 100, 0, 200, 320', '---', '',
  '### [spine](spine)', '---', 'Relic: oss',
  'Solid: capsule, 0, -2100, 0, 0, 2100, 0, 130', '---', '',
  '### [block](block)', '---', 'Relic: oss',
  'Solid: box, 10, 20, 30, 50, 60, 70', '---',
].join('\n');
const sm = R.parse(SOLIDS).relics[0];
const sphere = sm.solids.find((s) => s.shape === 'sphere');
const capsule = sm.solids.find((s) => s.shape === 'capsule');
const boxSolid = sm.solids.find((s) => s.shape === 'box');

check('a solid has a draw position at all',
  Number.isFinite(sphere.x) && Number.isFinite(sphere.y) && Number.isFinite(sphere.z));
check('sphere solid position and radius',
  sphere.x === 100 && sphere.z === 200 && sphere.r === 320);
check('capsule draws at its MIDPOINT',
  capsule.x === 0 && capsule.y === 0 && capsule.z === 0);
check('capsule radius is the LAST number, not the fourth', capsule.r === 130);
check('capsule keeps both endpoints',
  capsule.ay === -2100 && capsule.by === 2100);
check('box solid carries half-extents',
  boxSolid.hx === 50 && boxSolid.hy === 60 && boxSolid.hz === 70);

const capMoved = R.movePart(SOLIDS, capsule, 500, 600);
check('dragging a capsule TRANSLATES it - both endpoints move',
  capMoved.includes('Solid: capsule, 500, -2100, 600, 500, 2100, 600, 130'));
const capBack = R.parse(capMoved).relics[0].solids.find((s) => s.shape === 'capsule');
check('...and its length is unchanged',
  (capBack.by - capBack.ay) === (capsule.by - capsule.ay));
check('...and its radius survives', capBack.r === 130);

const sphMoved = R.parse(R.movePart(SOLIDS, sphere, 7, 8)).relics[0]
  .solids.find((s) => s.shape === 'sphere');
check('a sphere solid still moves plainly', sphMoved.x === 7 && sphMoved.z === 8);
check('...keeping its radius', sphMoved.r === 320);



// ------------------------------------------------------------- setPart
// One verb for every edit. The alternative is a function per field, each having to know
// how the three shapes lay their numbers out.
const sp1 = R.parse(R.setPart(DOC, hub, { r: 1500 })).relics[0]
  .chambers.find((c) => c.key === 'hub');
check('setPart edits a radius and leaves position alone',
  sp1.r === 1500 && sp1.x === 0 && sp1.y === 0);
const sp2 = R.parse(R.setPart(DOC, hub, { y: 2200 })).relics[0]
  .chambers.find((c) => c.key === 'hub');
check('setPart edits height alone', sp2.y === 2200 && sp2.r === 900);
const sp3 = R.parse(R.setPart(DOC, rel.boxes[0], { hy: 99 })).relics[0].boxes[0];
check('setPart edits one half-extent of a box',
  sp3.hy === 99 && sp3.hx === 900 && sp3.hz === 380);
check('setPart still changes exactly one line',
  DOC.split(NL).filter((l, i) => l !== R.setPart(DOC, hub, { r: 1 }).split(NL)[i]).length === 1);
check('setPart ignores a non-numeric value rather than writing junk',
  R.setPart(DOC, hub, { r: 'wide' }) === DOC);
check('an empty patch is a no-op', R.setPart(DOC, hub, {}) === DOC);

const capDoc = ['### [O](o)', '---', 'Loc: 0,0,0', '---', '', '### [s](s)', '---',
  'Relic: o', 'Solid: capsule, 0, -800, 0, 0, 800, 0, 60', '---'].join(NL);
const cap0 = R.parse(capDoc).relics[0].solids[0];
const capMoved2 = R.parse(R.setPart(capDoc, cap0, { x: 500 })).relics[0].solids[0];
check('setPart TRANSLATES a capsule rather than moving one end',
  capMoved2.ax === 500 && capMoved2.bx === 500
  && (capMoved2.by - capMoved2.ay) === (cap0.by - cap0.ay));



// -------------------------------------------- structural edits: add and remove
// Everything above rewrites ONE line. These insert and remove lines, which is a bigger
// promise: the surrounding document still must not move.
const STRUCT = ['### [O](oss)', '---', 'Loc: 0,0,0', '---', '',
  '### [hub](hub)', '---', 'Relic: oss', 'Chamber: 0, 0, 0, 900',
  'Passage to: gallery 300', '---', '',
  '### [gallery](gallery)', '---', 'Relic: oss', 'Chamber: 3000, 0, 0, 700', '---', '',
  'Prose about the gallery.'].join(NL);
const S = (t) => R.parse(t).relics[0];
const sHub = S(STRUCT).chambers.find((c) => c.key === 'hub');
const sGal = S(STRUCT).chambers.find((c) => c.key === 'gallery');

check('a passage appends to an existing list',
  R.addPassage(STRUCT, sHub, 'gallery2', 250).indexOf('gallery 300, gallery2 250') >= 0);
const ins = R.addPassage(STRUCT, sGal, 'hub', 180);
check('a chamber with no passages gets the line inserted',
  ins.indexOf('Passage to: hub 180') >= 0
  && ins.split(NL).length === STRUCT.split(NL).length + 1);
check('the inserted line lands inside the right fence',
  S(ins).passages.filter((p) => p.from === 'gallery').length === 1);
check('a duplicate passage is refused', R.addPassage(STRUCT, sHub, 'gallery', 300) === STRUCT);
check('a chamber cannot be joined to itself',
  R.addPassage(STRUCT, sHub, 'hub', 300) === STRUCT);

const two = R.addPassage(STRUCT, sHub, 'vault', 250);
const back = R.removePassage(two, S(two).chambers.find((c) => c.key === 'hub'), 'vault');
check('removing one passage keeps the others', back === STRUCT);
const gone = R.removePassage(STRUCT, sHub, 'gallery');
check('removing the last passage removes the whole line',
  gone.indexOf('Passage to:') < 0
  && gone.split(NL).length === STRUCT.split(NL).length - 1);
check('removing a passage that is not there changes nothing',
  R.removePassage(STRUCT, sHub, 'nosuch') === STRUCT);

const added = R.addChamber(STRUCT, S(STRUCT), 'crypt', -2000, -500, 0, 650, 'the crypt');
const crypt = S(added).chambers.find((c) => c.key === 'crypt');
check('an added chamber parses back with its numbers',
  crypt && crypt.x === -2000 && crypt.y === -500 && crypt.r === 650);
check('it is written in the shape a person would write it',
  added.indexOf('### [the crypt](crypt)') >= 0 && added.indexOf('Relic: oss') >= 0);
check('adding a chamber leaves the prose alone',
  added.indexOf('Prose about the gallery.') >= 0);

const del = R.removePart(STRUCT, S(STRUCT), sGal);
check('deleting a chamber removes its record',
  del.indexOf('### [gallery](gallery)') < 0);
check('...and every passage that named it', S(del).passages.length === 0);
check('...and leaves the other chamber intact',
  S(del).chambers.length === 1 && S(del).chambers[0].key === 'hub');
// The one thing a click must never destroy.
check('...but does NOT delete hand-written prose',
  del.indexOf('Prose about the gallery.') >= 0);


console.log('');
if (failures) { console.log(failures + ' failure(s)'); process.exit(1); }
// Split without a regex literal: this file has been rewritten by tooling that mangles
// escapes inside them, and a broken regex here is a syntax error that takes the whole
// suite down rather than failing one check.
function splitLines(s) {
  return String(s).split(String.fromCharCode(13)).join('').split(String.fromCharCode(10));
}

// --- renaming ---------------------------------------------------------------
// The display text is the one thing about a part an author says in WORDS, and until now
// the editor could change every number and not the name.
{
  const rel = R.parse(DOC).relics[0];
  const hub = rel.chambers[0];
  const out = R.setName(DOC, hub, 'The Great Hub');
  const before = DOC.split(NL), after = splitLines(out);
  const changed = before.map((l, i2) => (l !== after[i2] ? i2 : -1)).filter((i2) => i2 >= 0);
  check('a rename rewrites exactly one line', changed.length === 1);
  check('...the heading', after[changed[0]].indexOf('[The Great Hub]') >= 0);
  const re = R.parse(out).relics[0];
  check('...and the new name parses back', re.chambers[0].name === 'The Great Hub');
  // Passages name their ends by KEY, so renaming one here would silently orphan every
  // corridor that reached it. A rename in an editor must not be able to disconnect a relic.
  check('the key is untouched', re.chambers[0].key === hub.key);
  check('...so every passage survives', re.passages.length === rel.passages.length);
  // `]` would end the link text early and `[` opens one.
  check('brackets are stripped rather than breaking the heading',
    R.parse(R.setName(DOC, hub, 'a[b]c')).relics[0].chambers[0].name === 'abc');
  check('a newline cannot split the heading in two',
    splitLines(R.setName(DOC, hub, 'a' + NL + 'b')).length === before.length);
  check('an empty name is allowed - it is a heading, not a key',
    R.parse(R.setName(DOC, hub, '')).relics[0].chambers[0].name === '');
  check('a part with no heading line is left alone',
    R.setName(DOC, { key: 'x' }, 'zz') === DOC);
}

console.log('all relic model tests passed');
