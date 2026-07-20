// Shared GUI Editor model: the element catalog + code-gen (model → MAST) and the
// round-trip parser (MAST → model). Loaded by the editor webview AND required by
// the Node round-trip test, so the two can't drift. Pure — no DOM, no vscode.
//
//   const g   = GuiModel.generate(model);       // model → MAST text
//   const { model, nextId } = GuiModel.parse(g);// MAST text → model (+ next id)
//
// Only the editor's own bounded dialect is parsed; unrecognised lines (comments,
// anything else) become 'raw' nodes and are re-emitted verbatim, so a whole file
// round-trips losslessly.
(function (root, factory) {
  const M = factory();
  if (typeof module !== 'undefined' && module.exports) { module.exports = M; }
  if (root) { root.GuiModel = M; }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {

  // container flag (cont), whether it's a `with` block, default props, and the
  // fields the inspector edits.
  const CAT = {
    root:        { label: 'Screen',       cont: true,  fields: [] },
    section:     { label: 'Section',      cont: true,  props: { area: '5,5,95,95' }, fields: [['area', 'Area  l,t,r,b']] },
    sub_section: { label: 'Sub-section',  cont: true,  with: true, props: { style: '' }, fields: [['style', 'Style']] },
    row:         { label: 'Row',          cont: true,  props: { style: '' }, fields: [['style', 'Style']] },
    grid:        { label: 'Grid',         cont: true,  with: true, props: { columns: '3' }, fields: [['columns', 'Columns']] },
    list:        { label: 'List',         cont: true,  with: true, props: { items: 'items', as: 'item', select: 'true', title: '' }, fields: [['items', 'Items variable'], ['as', 'Row variable'], ['select', 'Select (true/false)'], ['title', 'Title (optional)']] },
    text:        { label: 'Text',         cont: false, props: { text: 'Hello', style: '' }, fields: [['text', 'Text'], ['style', 'Style (optional)']] },
    button:      { label: 'Button',       cont: false, props: { text: 'OK', jump: '' }, fields: [['text', 'Label'], ['jump', 'Jump to label (optional)']] },
    checkbox:    { label: 'Checkbox',     cont: false, props: { props: 'state:False;', style: '' }, fields: [['props', 'Props'], ['style', 'Style']] },
    slider:      { label: 'Slider',       cont: false, props: { props: 'low:0;high:100;', style: '' }, fields: [['props', 'Props'], ['style', 'Style']] },
    input:       { label: 'Input',        cont: false, props: { var: 'value', style: '' }, fields: [['var', 'Bind variable'], ['style', 'Style']] },
    face:        { label: 'Face',         cont: false, props: { var: 'face', style: '' }, fields: [['var', 'Face variable'], ['style', 'Style']] },
    icon:        { label: 'Icon',         cont: false, props: { props: 'icon_index:1;', style: '' }, fields: [['props', 'Props'], ['style', 'Style']] },
    image:       { label: 'Image',        cont: false, props: { props: '', style: '' }, fields: [['props', 'Props'], ['style', 'Style']] },
    blank:       { label: 'Blank',        cont: false, props: { count: '1' }, fields: [['count', 'Count']] },
    table:       { label: 'Table',        cont: false, props: { items: 'rows', columns: "[{'key':'name','label':'Name'}]", select: 'true' }, fields: [['items', 'Items variable'], ['columns', 'Columns (list of dicts)'], ['select', 'Select (true/false)']] },
  };

  // --- code generation: model -> MAST lines ---
  function q(s) { return String(s == null ? '' : s); }
  function textProps(p) { let s = '$text:' + q(p.text) + ';'; if (p.style) { s += q(p.style); } return s; }
  function pad(n) { let s = ''; for (let i = 0; i < n; i++) { s += '    '; } return s; }
  function body(n, ind) { const g = gen(n.children, ind); return g.length ? g : [pad(ind) + 'gui_blank()']; }
  function gen(nodes, ind) {
    let out = [];
    for (const n of nodes) {
      const p = n.props;
      switch (n.type) {
        case 'section': out.push(pad(ind) + 'gui_section("area: ' + q(p.area) + ';")'); out = out.concat(gen(n.children, ind)); break;
        case 'row': out.push(pad(ind) + 'gui_row("' + q(p.style) + '")'); out = out.concat(gen(n.children, ind)); break;
        case 'sub_section': out.push(pad(ind) + 'with gui_sub_section("' + q(p.style) + '"):'); out = out.concat(body(n, ind + 1)); break;
        case 'grid': out.push(pad(ind) + 'with gui_grid(' + q(p.columns) + '):'); out = out.concat(body(n, ind + 1)); break;
        case 'list': {
          let a = 'gui_list(' + q(p.items);
          if (p.select === 'true') { a += ', select=True'; }
          if (p.title) { a += ', title="' + q(p.title) + '"'; }
          a += ') as ' + (q(p.as) || 'item') + ':';
          out.push(pad(ind) + 'with ' + a); out = out.concat(body(n, ind + 1)); break;
        }
        case 'text': out.push(pad(ind) + 'gui_text("' + textProps(p) + '")'); break;
        case 'button':
          if (q(p.jump)) { out.push(pad(ind) + 'gui_button("' + q(p.text) + '"):'); out.push(pad(ind + 1) + 'jump ' + q(p.jump)); }
          else { out.push(pad(ind) + 'gui_button("' + q(p.text) + '")'); }
          break;
        case 'checkbox': out.push(pad(ind) + 'gui_checkbox("' + q(p.props) + '", "' + q(p.style) + '")'); break;
        case 'slider': out.push(pad(ind) + 'gui_slider("' + q(p.props) + '", "' + q(p.style) + '")'); break;
        case 'input': out.push(pad(ind) + 'gui_input("", var="' + q(p.var) + '")'); break;
        case 'face': out.push(pad(ind) + 'gui_face(' + q(p.var) + ')'); break;
        case 'icon': out.push(pad(ind) + 'gui_icon("' + q(p.props) + '", "' + q(p.style) + '")'); break;
        case 'image': out.push(pad(ind) + 'gui_image("' + q(p.props) + '", "' + q(p.style) + '")'); break;
        case 'blank': out.push(pad(ind) + 'gui_blank(' + q(p.count) + ')'); break;
        case 'table': {
          let a = 'gui_table(' + q(p.items) + ', ' + q(p.columns);
          if (p.select === 'true') { a += ', select=True'; }
          a += ')'; out.push(pad(ind) + a); break;
        }
        case 'raw': out.push(pad(ind) + q(p.line)); break;
      }
    }
    return out;
  }
  function generate(model) { return gen(model.children, 0).join('\n'); }

  // --- round-trip parse: MAST lines -> model ---
  function indentOf(s) { let n = 0; while (s.charAt(n) === ' ') { n++; } return n; }
  function parseTextProps(s) { const m = s.match(/^\$text:([\s\S]*?);([\s\S]*)$/); return m ? { text: m[1], style: m[2] } : { text: s, style: '' }; }
  function parseListArgs(s) {
    const p = { items: '', as: 'item', select: 'false', title: '' };
    const ci = s.indexOf(',');
    if (ci >= 0) {
      p.items = s.slice(0, ci).trim();
      const rest = s.slice(ci + 1);
      if (/select\s*=\s*True/.test(rest)) { p.select = 'true'; }
      const tm = rest.match(/title\s*=\s*"([^"]*)"/); if (tm) { p.title = tm[1]; }
    } else { p.items = s.trim(); }
    return p;
  }
  function parseLine(s) {
    let m;
    if ((m = s.match(/^gui_section\("area:\s*(.+?);?"\)$/))) { return { type: 'section', props: { area: m[1].trim() } }; }
    if ((m = s.match(/^gui_row\("(.*)"\)$/))) { return { type: 'row', props: { style: m[1] } }; }
    if ((m = s.match(/^with gui_sub_section\("(.*)"\):$/))) { return { type: 'sub_section', with: true, props: { style: m[1] } }; }
    if ((m = s.match(/^with gui_grid\((.+?)\):$/))) { return { type: 'grid', with: true, props: { columns: m[1].trim() } }; }
    if ((m = s.match(/^with gui_list\((.+)\) as (\w+):$/))) { const p = parseListArgs(m[1]); p.as = m[2]; return { type: 'list', with: true, props: p }; }
    if ((m = s.match(/^gui_text\("(.*)"\)$/))) { return { type: 'text', props: parseTextProps(m[1]) }; }
    if ((m = s.match(/^gui_button\("(.*?)"\)(:?)$/))) { return { type: 'button', props: { text: m[1], jump: '' }, needsJump: m[2] === ':' }; }
    if ((m = s.match(/^gui_checkbox\("(.*)",\s*"(.*)"\)$/))) { return { type: 'checkbox', props: { props: m[1], style: m[2] } }; }
    if ((m = s.match(/^gui_slider\("(.*)",\s*"(.*)"\)$/))) { return { type: 'slider', props: { props: m[1], style: m[2] } }; }
    if ((m = s.match(/^gui_icon\("(.*)",\s*"(.*)"\)$/))) { return { type: 'icon', props: { props: m[1], style: m[2] } }; }
    if ((m = s.match(/^gui_image\("(.*)",\s*"(.*)"\)$/))) { return { type: 'image', props: { props: m[1], style: m[2] } }; }
    if ((m = s.match(/^gui_input\("",\s*var="(.+?)"\)$/))) { return { type: 'input', props: { var: m[1], style: '' } }; }
    if ((m = s.match(/^gui_face\((.+?)\)$/))) { return { type: 'face', props: { var: m[1], style: '' } }; }
    if ((m = s.match(/^gui_blank\((.+?)\)$/))) { return { type: 'blank', props: { count: m[1] } }; }
    if ((m = s.match(/^gui_table\((.+?),\s*(\[[\s\S]*\])(,\s*select\s*=\s*True)?\)$/))) { return { type: 'table', props: { items: m[1].trim(), columns: m[2], select: m[3] ? 'true' : 'false' } }; }
    return { type: 'raw', props: { line: s } };
  }
  function parseStatements(lines, i, base) {
    const out = [];
    while (i < lines.length) {
      const raw = lines[i];
      if (!raw.trim() || raw.trim() === '# (nothing yet)') { i++; continue; }   // skip blanks + stray placeholder
      const ind = indentOf(raw);
      if (ind < base) { break; }
      if (ind > base) { i++; continue; }
      const st = parseLine(raw.trim()); i++;
      if (st.with) { const r = parseStatements(lines, i, base + 4); st.children = r.out; i = r.i; }
      else if (st.type === 'button' && st.needsJump && i < lines.length && indentOf(lines[i]) > base) {
        const jm = lines[i].trim().match(/^jump\s+(\S+)/); if (jm) { st.props.jump = jm[1]; } i++;
      }
      out.push(st);
    }
    return { out: out, i: i };
  }
  function parse(text) {
    let idc = 0;
    function mkParsed(st) {
      const n = { id: ++idc, type: st.type, props: Object.assign({}, st.props) };
      const c = CAT[st.type];
      if ((c && c.cont) || st.with) { n.children = []; }
      return n;
    }
    function buildFlow(stmts, list) {
      let curSec = null, curRow = null;
      for (const st of stmts) {
        const n = mkParsed(st);
        if (st.type === 'section') { list.push(n); curSec = n; curRow = null; }
        else if (st.type === 'row') { (curSec ? curSec.children : list).push(n); curRow = n; }
        else { (curRow ? curRow.children : (curSec ? curSec.children : list)).push(n); }
        if (st.children && n.children) { buildFlow(st.children, n.children); }
      }
    }
    const lines = String(text || '').replace(/\r/g, '').split('\n');
    const r = parseStatements(lines, 0, 0);
    const rootNode = { id: 0, type: 'root', children: [] };
    buildFlow(r.out, rootNode.children);
    return { model: rootNode, nextId: idc };
  }

  return { CAT: CAT, gen: gen, generate: generate, parse: parse };
});
