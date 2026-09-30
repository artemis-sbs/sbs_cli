// Tests for the Tile Map Editor's shared model (media/tilesModel.js).
// Run: npm run test:tiles   (or: node test/tilesModel.test.js)
//
// The property that matters: a paint stroke rewrites ONLY the map rows it changed, so
// comments, the header and the legend's spacing survive every edit.
const T = require('../media/tilesModel.js');

let failures = 0;
function check(name, cond) {
  if (cond) { console.log('  ok  - ' + name); }
  else { console.log('  FAIL- ' + name); failures++; }
}

const AREA = [
  '# a comment the editor must never eat',
  'area: ridge',
  'title: Landing Ridge',
  'tileset: mereth',
  'entry: landing',
  'legend:',
  '  .: dust',
  '  #: rock',
  '  :: salt',
  '  L: dust   @landing',
  'exits:',
  '  to_colony: colony @to_ridge',
  '---',
  '#####',
  '#.L.#',
  '#:::',
  '#####',
  '',
].join('\n');

console.log('parse');
const m = T.parse(AREA);
check('header keys and lines', m.header.area.value === 'ridge' && m.header.entry.line === 4);
check('legend: # and : are keys, marks read', m.legend.map((e) => e.ch).join('') === '.#:L'
  && m.legend[3].mark === 'landing' && m.legend[3].kind === 'dust');
check('exits', m.exits.length === 1 && m.exits[0].mark === 'to_colony');
check('separator and rows', m.sep === 12 && m.rows.length === 4);
check('size from the longest row', m.width === 5 && m.height === 4);
check('the grid pads a short row with nothing', T.grid(m)[2].join('') === '#::: ');

console.log('\nrow edits');
let cells = T.paint(T.grid(m), 1, 1, '#');
let edits = T.rowEdits(m, cells);
check('one stroke, one row', edits.length === 1 && edits[0].start === 14);
let out = T.applyEdits(AREA, edits);
check('only that row changed', out === AREA.replace('#.L.#', '##L.#'));
check('the comment survives', out.startsWith('# a comment'));

cells = T.grid(m);
edits = T.rowEdits(m, cells);
check('an unchanged grid is no edit (trailing padding is not a change)', edits.length === 0);

cells = T.paint(T.grid(m), 4, 2, ' ');
check('erasing to nothing at the end of a row trims it',
  T.rowEdits(m, cells).length === 0);

cells = T.resize(T.grid(m), 5, 6);
cells = T.paint(cells, 0, 5, '#');
out = T.applyEdits(AREA, T.rowEdits(m, cells));
check('growing adds rows at the bottom', T.parse(out).height === 6
  && out.endsWith('#####\n\n#\n'));

cells = T.resize(T.grid(m), 5, 2);
out = T.applyEdits(AREA, T.rowEdits(m, cells));
check('shrinking removes rows', T.parse(out).rows.join('|') === '#####|#.L.#');

const CRLF = AREA.replace(/\n/g, '\r\n');
out = T.applyEdits(CRLF, T.rowEdits(T.parse(CRLF), T.paint(T.grid(T.parse(CRLF)), 1, 1, '#')));
check('CRLF files keep CRLF', out === CRLF.replace('#.L.#', '##L.#'));

const SIZED = AREA.replace('entry: landing', 'entry: landing\nsize: 5x4');
const ms = T.parse(SIZED);
out = T.applyEdits(SIZED, T.rowEdits(ms, T.resize(T.grid(ms), 7, 4)));
check('a size: header follows a resize', /size: 7x4/.test(out));

// What the extension writes for a Resize on a file with no size: header: the rows AND
// a new header, computed against the same text and applied together.
cells = T.resize(T.grid(m), 7, 6);
out = T.applyEdits(AREA, T.rowEdits(m, cells).concat([T.headerEdit(m, 'size', '7x6')]));
const grown = T.parse(out);
check('a resize with a new size: header keeps blank edges', grown.width === 7 && grown.height === 6
  && out.includes('entry: landing\nsize: 7x6\nlegend:'));

const NOMAP = 'area: x\nlegend:\n  .: dust\n';
out = T.applyEdits(NOMAP, T.rowEdits(T.parse(NOMAP), [['.', '.'], ['.', '.']]));
check('a file with no map gets one', out === 'area: x\nlegend:\n  .: dust\n---\n..\n..\n');

console.log('\nlegend and header');
out = T.applyEdits(AREA, [T.legendAddEdit(m, 'w', 'brine', null)]);
check('a new entry goes after the last legend line',
  out.includes('  L: dust   @landing\n  w: brine\nexits:'));
out = T.applyEdits(AREA, [T.legendAddEdit(m, 'o', 'salt', 'Obelisk')]);
check('a mark is written lowercase with @', out.includes('  o: salt @obelisk\n'));
out = T.applyEdits(AREA, [T.legendSetEdit(m, ':', 'dust', null)]);
check('changing an entry keeps its character', out.includes('  :: dust\n') && !out.includes(':: salt'));
out = T.applyEdits('area: x\ntileset: t\n---\n..\n', [T.legendAddEdit(T.parse('area: x\ntileset: t\n---\n..\n'), '.', 'dust')]);
check('no legend yet: one is made above the map', out === 'area: x\ntileset: t\nlegend:\n  .: dust\n---\n..\n');
out = T.applyEdits(AREA, [T.headerEdit(m, 'entry', '3, 1')]);
check('set the entry', out.includes('entry: 3, 1\n'));
out = T.applyEdits('area: x\nlegend:\n  .: d\n---\n.\n', [T.headerEdit(T.parse('area: x\nlegend:\n  .: d\n---\n.\n'), 'entry', '0, 0')]);
check('add the entry above the legend', out === 'area: x\nentry: 0, 0\nlegend:\n  .: d\n---\n.\n');
check('a free character prefers the kind initial', T.freeChar(m, 'water') === 'w');
check('... then its capital', T.freeChar(T.parse(AREA.replace('  .: dust', '  .: dust\n  w: water')), 'water') === 'W');
check('never a space', T.freeChar(m, ' ') !== ' ');

console.log('\ntools');
const g = T.grid(m);
check('fill stays inside its region', T.fill(g, 1, 2, '~').map((r) => r.join('')).join('|')
  === '#####|#.L.#|#~~~ |#####');
check('fill of nothing fills the nothing', T.fill(g, 4, 2, '.')[2].join('') === '#:::.');
check('rect fills', T.rect(g, 1, 1, 3, 2, '~')[1].join('') === '#~~~#');
check('rect outline', T.rect(T.resize(g, 5, 5), 0, 0, 4, 4, '=', true)[2].join('') === '=:::=');
check('a line has no gaps', T.line(0, 0, 3, 1).length === 4);
check('paint off the map is nothing', T.paint(g, 9, 9, '#') === g);
check('lint line -> cell', JSON.stringify(T.cellOfLine(m, 14, 2)) === '{"x":2,"y":1}'
  && T.cellOfLine(m, 3, 0) === null);

console.log('\nplacements');
check('a cell reads as At: or as a patrol point', JSON.stringify(T.parseCell('18, 3')) === '[18,3]'
  && JSON.stringify(T.parseCell(' 25 4 ')) === '[25,4]');
check('a word is not a cell', T.parseCell('landing') === null && T.parseCell('') === null);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
