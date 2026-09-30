// Tests for the Tileset Editor's shared model (media/tilesetModel.js).
// Run: npm run test:tileset   (or: node test/tilesetModel.test.js)
//
// The properties that matter: an edit rewrites ONE line, and the line comes out lined up
// the way the author lined up the rest of the file.
const S = require('../media/tilesetModel.js');
const T = require('../media/tilesModel.js');      // its applyEdits: VS Code's edit semantics

let failures = 0;
function check(name, cond) {
  if (cond) { console.log('  ok  - ' + name); }
  else { console.log('  FAIL- ' + name); failures++; }
}

const FILE = [
  '# Mereth',
  'tileset: mereth',
  'title: Mereth surface',
  'kinds:',
  '  dust:        walk see   look=dirt',
  '  scrub:       walk see   look=dirt_grass',
  '  cliff:            see   look=cliff',
  '  rock:                   look=rock',
  '  # a way out',
  '  exit:        walk see   look=exit      # bright chevrons',
  '',
].join('\n');

console.log('parse');
const m = S.parse(FILE);
check('header', m.header.tileset.value === 'mereth' && m.header.title.value === 'Mereth surface');
check('kinds, comments skipped', m.kinds.map((k) => k.name).join(',') === 'dust,scrub,cliff,rock,exit');
const cliff = m.kinds[2];
check('rules as written', !cliff.rules.walk && cliff.rules.see && cliff.rules.look === 'cliff');
check('a trailing comment is kept', m.kinds[4].comment === '# bright chevrons');
check('no errors', m.errors.length === 0);
const bad = S.parse('tileset: t\nkinds:\n  dust: wlak\n');
check('a typo is reported', bad.errors.length === 1 && bad.errors[0].line === 2);

console.log('\nalignment');
const cols = S.columns(m);
check('columns learned from the file', cols.walk === 15 && cols.see === 20 && cols.look === 26);
check('a new line lines up',
  S.formatLine(m, 'brine', { see: true, look: 'water' }) === '  brine:            see   look=water');
check('a rule wider than its slot still gets a space',
  S.formatLine(m, 'glyphfloor_long', { walk: true }) === '  glyphfloor_long: walk');

console.log('\nedits');
let out = T.applyEdits(FILE, [S.kindEdit(m, 'rock', 'rock', { walk: true, see: true, look: 'rock' })]);
check('turning walk on rewrites that one line, aligned',
  out === FILE.replace('  rock:                   look=rock', '  rock:        walk see   look=rock'));
out = T.applyEdits(FILE, [S.kindEdit(m, 'exit', 'exit', { walk: true, see: true, look: 'exit', color: '#4f4' })]);
check('the comment survives an edit', out.includes('look=exit color=#4f4') && out.includes('# bright chevrons'));
out = T.applyEdits(FILE, [S.kindEdit(m, 'dust', 'dirt', { walk: true, see: true, look: 'dirt' })]);
check('rename', out.includes('  dirt:        walk see   look=dirt') && !out.includes('dust:'));
out = T.applyEdits(FILE, [S.addEdit(m, 'brine', { see: true, look: 'water' })]);
check('a new kind goes after the last one', out.endsWith('# bright chevrons\n  brine:            see   look=water\n'));
out = T.applyEdits(FILE, [S.removeEdit(m, 'scrub')]);
check('remove deletes the line only', !out.includes('scrub') && out.includes('  cliff:'));
out = T.applyEdits(FILE, [S.headerEdit(m, 'title', 'Mereth by night')]);
check('header edit', out.includes('title: Mereth by night\n'));
out = T.applyEdits('tileset: t\n', [S.addEdit(S.parse('tileset: t\n'), 'dust', { walk: true })]);
check('no kinds: yet - one is made', out === 'tileset: t\nkinds:\n  dust: walk\n');
out = T.applyEdits(FILE.replace(/\n/g, '\r\n'),
  [S.kindEdit(S.parse(FILE.replace(/\n/g, '\r\n')), 'rock', 'rock', { look: 'stone' })]);
check('CRLF stays CRLF', out.includes('look=stone\r\n') && !/[^\r]\n/.test(out));
check('over is a number', S.formatLine(m, 'x', { over: 3 }).endsWith('over=3')
  && !S.formatLine(m, 'x', { over: 'high' }).includes('over'));

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
