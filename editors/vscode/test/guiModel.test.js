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
      { id: 4, type: 'button', props: { text: 'A', style: '', on_click: '' } },
      { id: 5, type: 'button', props: { text: 'Hail', style: '', on_click: 'jump hail' } },
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

// 2) A hand-written complete gui under its label (comments + a raw ~~…~~ line +
//    a handler) round-trips verbatim.
const src = [
  '=== my_gui',
  '    # a hand comment survives',
  '    gui_section("area: 5,5,95,90;")',
  '    gui_text("$text:Fleet;justify:center;")',
  '    gui_button("Hail")',
  '    ~~ custom = 1 ~~',
  '    on gui_message(gui_button("Hail")):',
  '        jump hail',
  '    await gui()',
].join('\n');
const round = GuiModel.generate(GuiModel.parse(src).model);
check('hand-written file survives byte-for-byte', round === src);
check('label parsed', GuiModel.parse(src).model.props.label === 'my_gui');
check('comments kept', round.includes('# a hand comment'));
check('raw ~~…~~ line kept', round.includes('~~ custom = 1 ~~'));

// 3) sections/rows nest under their flow; with-blocks nest by indent.
const m = GuiModel.parse('gui_section("area: 0,0,100,100;")\ngui_row("")\ngui_text("$text:hi;")').model;
check('section holds the row', m.children[0].type === 'section' && m.children[0].children[0].type === 'row');
check('row holds the text', m.children[0].children[0].children[0].type === 'text');

// 4) empty model generates empty (no placeholder written).
check('empty model -> empty string', GuiModel.generate({ children: [] }) === '');

// 5) button style + on_click (on gui_message) + list row_height round-trip.
const forms = [
  '=== my_gui',
  '    gui_section("area: 0,0,100,100;")',
  '    gui_button("Plain")',
  '    gui_button("Styled", "color:red;")',
  '    gui_button("Go")',
  '    with gui_list(ships, select=True, title="Ships", row_height="3em") as ship:',
  '        gui_text("$text:hi;")',
  '    on gui_message(gui_button("Go")):',
  '        jump other',
  '    await gui()',
].join('\n');
check('button style / on_click / list row_height round-trip', GuiModel.generate(GuiModel.parse(forms).model) === forms);
const b = GuiModel.parse('gui_button("X", "color:red;")').model.children[0];
check('button style parsed', b.props.style === 'color:red;' && b.props.on_click === '');
const bh = GuiModel.parse('gui_button("Go")\non gui_message(gui_button("Go")):\n    jump other\nawait gui()').model.children[0];
check('button on_click attached from handler', bh.type === 'button' && bh.props.on_click === 'jump other');
const lst = GuiModel.parse('with gui_list(a, row_height="3em") as x:\n    gui_text("$text:h;")').model.children[0];
check('list row_height parsed', lst.props.row_height === '3em');

// 5b) gui_table container (with form) + headers round-trip.
const tbl = [
  '=== my_gui',
  '    with gui_table(fleet, headers=["Ship", "Hull"], select=True) as row:',
  '        gui_text("$text:{row[\'name\']};")',
  '        gui_text("$text:{row[\'hull\']};")',
  '    await gui()',
].join('\n');
check('gui_table with-form round-trip', GuiModel.generate(GuiModel.parse(tbl).model) === tbl);
const tn = GuiModel.parse(tbl).model.children[0];
check('table is a container with cells', tn.type === 'table' && tn.children && tn.children.length === 2);
check('table headers parsed', tn.props.headers === 'Ship, Hull' && tn.props.as === 'row');

// 6) section style round-trips; a plain section (no style) is unchanged.
const styled = '=== my_gui\n    gui_section("area: 5,5,95,95;background:#123;")\n    await gui()';
check('section style round-trip', GuiModel.generate(GuiModel.parse(styled).model) === styled);
const plain = '=== my_gui\n    gui_section("area: 5,5,95,95;")\n    await gui()';
check('plain section unchanged', GuiModel.generate(GuiModel.parse(plain).model) === plain);
const sec = GuiModel.parse('gui_section("area: 0,0,50,50;background:#1;")').model.children[0];
check('section area/style split', sec.props.area === '0,0,50,50' && sec.props.style === 'background:#1;');

// 7) engine widgets round-trip and parse to their proper types.
const eng = [
  '=== my_gui',
  '    gui_section("area: 0,0,100,100;")',
  '    gui_text_area("## Status")',
  '    gui_ship("battleship")',
  '    gui_drop_down("items:Red,Green;", var="choice")',
  '    gui_int_slider("low:0;high:100;", var="value")',
  '    gui_radio("items:A,B;", var="pick")',
  '    gui_icon_button("icon_index:1;", "color:red;")',
  '    await gui()',
].join('\n');
check('engine widgets round-trip', GuiModel.generate(GuiModel.parse(eng).model) === eng);
const ek = GuiModel.parse(eng).model.children[0].children.map(c => c.type);
check('engine widgets parse to their types',
  JSON.stringify(ek) === JSON.stringify(['text_area','ship','dropdown','int_slider','radio','icon_button']));
const dd = GuiModel.parse('gui_drop_down("items:A,B;", var="speed")').model.children[0];
check('dropdown items/var parsed', dd.props.items === 'items:A,B;' && dd.props.var === 'speed');
const ta = GuiModel.parse('gui_ship("cruiser", "area:0,0,50,50;")').model.children[0];
check('ship type/style parsed', ta.props.props === 'cruiser' && ta.props.style === 'area:0,0,50,50;');

// 8) engine console widgets + console setup (layout_widget / console / activate / cinematic).
const con = [
  '=== my_gui',
  '    gui_section("area: 0,0,100,100;")',
  '    gui_layout_widget("3dview")',
  '    gui_activate_console("cinematic")',
  '    gui_console("helm")',
  '    gui_cinematic_auto(client_id)',
  '    gui_cinematic_full_control(client_id, sel, source, sel, Vec3())',
  '    await gui()',
].join('\n');
check('console widgets round-trip', GuiModel.generate(GuiModel.parse(con).model) === con);
const walk = (model) => { const out = []; (function w(ns){ for (const n of ns) { out.push(n); if (n.children) w(n.children); } })(model.children); return out; };
const cnodes = walk(GuiModel.parse(con).model);
const ctypes = cnodes.map(n => n.type);
check('console types all present', ['layout_widget','activate_console','console_preset','cinematic'].every(t => ctypes.includes(t)));
check('layout_widget widget parsed', cnodes.find(n => n.type === 'layout_widget').props.widget === '3dview');
const cins = cnodes.filter(n => n.type === 'cinematic');
check('cinematic auto + full parsed',
  cins.some(n => n.props.mode === 'auto') &&
  cins.some(n => n.props.mode === 'full' && n.props.args === 'sel, source, sel, Vec3()'));

// 9) control event handlers: ref-form (dl = gui_slider) + label-form button round-trip and reattach.
const h = [
  '=== my_gui',
  '    gui_section("area: 0,0,100,100;")',
  '    dl = gui_slider("low:0;high:300;", "")',
  '    cb = gui_checkbox("state:False;", "")',
  '    gui_button("Go")',
  '    on gui_message(dl):',
  '        set_dolly()',
  '    on gui_message(cb):',
  '        toggle()',
  '    on gui_message(gui_button("Go")):',
  '        jump other',
  '    await gui()',
].join('\n');
check('control handlers round-trip', GuiModel.generate(GuiModel.parse(h).model) === h);
const hk = GuiModel.parse(h).model.children[0].children;
const sl = hk.find(c => c.type === 'slider'), cbn = hk.find(c => c.type === 'checkbox'), bn = hk.find(c => c.type === 'button');
check('slider ref + on_message reattached', sl.props.ref === 'dl' && sl.props.on_message === 'set_dolly()');
check('checkbox ref + on_message reattached', cbn.props.ref === 'cb' && cbn.props.on_message === 'toggle()');
check('button on_click still by label', bn.props.on_click === 'jump other');

// 10) a button matched by REF (b = gui_button) + a label-form button both round-trip.
const bref = [
  '=== my_gui',
  '    gui_section("area: 0,0,100,100;")',
  '    b = gui_button("B")',
  '    gui_button("OK")',
  '    on gui_message(b):',
  '        print("")',
  '    on gui_message(gui_button("OK")):',
  '        print("")',
  '    await gui()',
].join('\n');
check('button-ref + label handlers round-trip', GuiModel.generate(GuiModel.parse(bref).model) === bref);
const brk = GuiModel.parse(bref).model.children[0].children;
const bbtn = brk.find(c => c.type === 'button' && c.props.ref === 'b');
check('button matched by ref -> on_click', bbtn && bbtn.props.on_click === 'print("")');

// 11) a handler whose target isn't a modeled control is preserved verbatim, not dropped.
const ext = [
  '=== my_gui',
  '    gui_section("area: 0,0,100,100;")',
  '    gui_text("$text:hi;")',
  '    on gui_message(external_ctrl):',
  '        do_thing()',
  '    await gui()',
].join('\n');
check('unmatched handler preserved', GuiModel.generate(GuiModel.parse(ext).model) === ext);

if (failures) { console.log('\n' + failures + ' FAILED'); process.exit(1); }
console.log('\nall passed');
