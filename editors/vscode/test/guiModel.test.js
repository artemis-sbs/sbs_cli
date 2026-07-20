// Round-trip test for the GUI Editor's shared model (media/guiModel.js).
// Run: npm run test:gui   (or: node test/guiModel.test.js)
//
// Verifies model -> MAST -> model is byte-stable and that a hand-written file
// (comments + unmodeled lines) survives untouched.
const assert = require('assert');
const GuiModel = require('../media/guiModel.js');

let failures = 0;
function check(name, cond) {
  if (cond) { console.log('  ok  - ' + name); }
  else { console.log('  FAIL- ' + name); failures++; }
}

// 1) A model built in the editor generates, parses back, and regenerates identically.
const model = { id: 0, type: 'root', children: [
  { id: 1, type: 'section', props: { area: '5,5,60,90' }, children: [
    { id: 2, type: 'text', props: { text: 'Fleet', style: 'justify:center;' } },
    { id: 3, type: 'grid', props: { columns: '3' }, children: [
      { id: 4, type: 'button', props: { text: 'A', jump: '' } },
      { id: 5, type: 'button', props: { text: 'Hail', jump: 'hail' } },
    ] },
    { id: 6, type: 'list', props: { items: 'ships', as: 'ship', select: 'true', title: 'Ships' }, children: [
      { id: 7, type: 'text', props: { text: "{ship['name']}", style: '' } },
    ] },
  ] },
  { id: 8, type: 'section', props: { area: '65,5,95,90' }, children: [
    { id: 9, type: 'table', props: { items: 'rows', headers: 'Name, Hull', as: 'row', select: 'true' }, children: [
      { id: 10, type: 'text', props: { text: "{row['name']}", style: '' } },
      { id: 11, type: 'text', props: { text: "{row['hull']}", style: '' } },
    ] },
  ] },
] };
const code1 = GuiModel.generate(model);
const back = GuiModel.parse(code1);
const code2 = GuiModel.generate(back.model);
check('model -> gen -> parse -> gen is byte-stable', code1 === code2);

// 2) A hand-written file (comments + a raw ~~…~~ line) round-trips verbatim.
const src = [
  '# a hand comment survives',
  'gui_section("area: 5,5,60,90;")',
  'gui_text("$text:Fleet;justify:center;")',
  'with gui_grid(3):',
  '    gui_button("A")',
  '    gui_button("Hail"):',
  '        jump hail',
  '# another note',
  'with gui_list(ships, select=True, title="Ships") as ship:',
  "    gui_text(\"$text:{ship['name']};\")",
  'gui_section("area: 65,5,95,90;")',
  '~~ custom = 1 ~~',
  "gui_table(rows, [{'key':'name','label':'Name'}], select=True)",
].join('\n');
const round = GuiModel.generate(GuiModel.parse(src).model);
check('hand-written file survives byte-for-byte', round === src);
check('comments kept', round.includes('# a hand comment') && round.includes('# another note'));
check('raw ~~…~~ line kept', round.includes('~~ custom = 1 ~~'));

// 3) sections/rows nest under their flow; with-blocks nest by indent.
const m = GuiModel.parse('gui_section("area: 0,0,100,100;")\ngui_row("")\ngui_text("$text:hi;")').model;
check('section holds the row', m.children[0].type === 'section' && m.children[0].children[0].type === 'row');
check('row holds the text', m.children[0].children[0].children[0].type === 'text');

// 4) empty model generates empty (no placeholder written).
check('empty model -> empty string', GuiModel.generate({ children: [] }) === '');

// 5) button style + list row_height round-trip (all button forms).
const forms = [
  'gui_button("Plain")',
  'gui_button("Styled", "color:red;")',
  'gui_button("Jumpy"):\n    jump go',
  'gui_button("StyledJump", "color:red;"):\n    jump go',
  'with gui_list(ships, select=True, title="Ships", row_height="3em") as ship:\n    gui_text("$text:hi;")',
].join('\n');
check('button style / list row_height round-trip', GuiModel.generate(GuiModel.parse(forms).model) === forms);
const b = GuiModel.parse('gui_button("X", "color:red;")').model.children[0];
check('button style parsed', b.props.style === 'color:red;' && b.props.jump === '');
const lst = GuiModel.parse('with gui_list(a, row_height="3em") as x:\n    gui_text("$text:h;")').model.children[0];
check('list row_height parsed', lst.props.row_height === '3em');

// 5b) gui_table container (with form) + headers round-trip.
const tbl = 'with gui_table(fleet, headers=["Ship", "Hull"], select=True) as row:\n    gui_text("$text:{row[\'name\']};")\n    gui_text("$text:{row[\'hull\']};")';
check('gui_table with-form round-trip', GuiModel.generate(GuiModel.parse(tbl).model) === tbl);
const tn = GuiModel.parse(tbl).model.children[0];
check('table is a container with cells', tn.type === 'table' && tn.children && tn.children.length === 2);
check('table headers parsed', tn.props.headers === 'Ship, Hull' && tn.props.as === 'row');

// 6) section style round-trips; a plain section (no style) is unchanged.
check('section style round-trip', GuiModel.generate(GuiModel.parse('gui_section("area: 5,5,95,95;background:#123;")').model) === 'gui_section("area: 5,5,95,95;background:#123;")');
check('plain section unchanged', GuiModel.generate(GuiModel.parse('gui_section("area: 5,5,95,95;")').model) === 'gui_section("area: 5,5,95,95;")');
const sec = GuiModel.parse('gui_section("area: 0,0,50,50;background:#1;")').model.children[0];
check('section area/style split', sec.props.area === '0,0,50,50' && sec.props.style === 'background:#1;');

if (failures) { console.log('\n' + failures + ' FAILED'); process.exit(1); }
console.log('\nall passed');
