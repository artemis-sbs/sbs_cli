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
    root:        { label: 'Screen',       cont: true,  props: { label: 'my_gui' }, fields: [['label', 'Label name']] },
    section:     { label: 'Section',      cont: true,  props: { area: '5,5,95,95', style: '' }, fields: [['area', 'Area  l,t,r,b'], ['style', 'Style (background, border…)']] },
    sub_section: { label: 'Sub-section',  cont: true,  with: true, props: { style: '' }, fields: [['style', 'Style']] },
    row:         { label: 'Row',          cont: true,  props: { style: '' }, fields: [['style', 'Style']] },
    grid:        { label: 'Grid',         cont: true,  with: true, props: { columns: '3' }, fields: [['columns', 'Columns']] },
    list:        { label: 'List',         cont: true,  with: true, props: { items: 'items', as: 'item', select: 'true', title: '', row_height: '' }, fields: [['items', 'Items variable'], ['as', 'Row variable'], ['select', 'Select (true/false)'], ['title', 'Title (optional)'], ['row_height', 'Row height (e.g. 1.6em)']] },
    text:        { label: 'Text',         cont: false, props: { text: 'Hello', style: '' }, fields: [['text', 'Text'], ['style', 'Style (optional)']] },
    button:      { label: 'Button',       cont: false, props: { text: 'OK', style: '', on_click: '' }, fields: [['text', 'Label'], ['style', 'Style (optional)'], ['on_click', 'On click (e.g. jump hail)']] },
    checkbox:    { label: 'Checkbox',     cont: false, props: { props: 'state:False;', style: '', on_message: '', ref: '' }, fields: [['props', 'Props'], ['style', 'Style'], ['on_message', 'On message (handler)'], ['ref', 'Ref var (optional)']] },
    slider:      { label: 'Slider',       cont: false, props: { props: 'low:0;high:100;', style: '', on_message: '', ref: '' }, fields: [['props', 'Props'], ['style', 'Style'], ['on_message', 'On message (handler)'], ['ref', 'Ref var (optional)']] },
    input:       { label: 'Input',        cont: false, props: { var: 'value', style: '', on_message: '', ref: '' }, fields: [['var', 'Bind variable'], ['style', 'Style'], ['on_message', 'On message (handler)'], ['ref', 'Ref var (optional)']] },
    face:        { label: 'Face',         cont: false, props: { var: 'face', style: '' }, fields: [['var', 'Face variable'], ['style', 'Style']] },
    icon:        { label: 'Icon',         cont: false, props: { props: 'icon_index:1;', style: '' }, fields: [['props', 'Props'], ['style', 'Style']] },
    image:       { label: 'Image',        cont: false, props: { props: '', style: '' }, fields: [['props', 'Props'], ['style', 'Style']] },
    blank:       { label: 'Blank',        cont: false, props: { count: '1' }, fields: [['count', 'Count']] },
    table:       { label: 'Table',        cont: true,  with: true, props: { items: 'rows', headers: '', as: 'row', select: 'true' }, fields: [['items', 'Items variable'], ['headers', 'Headers (comma-separated)'], ['as', 'Row variable'], ['select', 'Select (true/false)']] },
    // Engine widgets — the richer, engine-specific controls (a 3D ship view, a
    // rich text area, dropdown/radio/int-slider, an icon button).
    text_area:   { label: 'Text area',    cont: false, props: { text: '## Status', style: '' }, fields: [['text', 'Markdown text'], ['style', 'Style (optional)']] },
    ship:        { label: 'Ship (3D)',    cont: false, props: { props: 'battleship', style: '' }, fields: [['props', 'Ship type (e.g. battleship)'], ['style', 'Style (area…)']] },
    dropdown:    { label: 'Dropdown',     cont: false, props: { items: 'items:Red,Green,Blue;', var: 'choice', style: '', on_message: '', ref: '' }, fields: [['items', 'Options (items:A,B,C;)'], ['var', 'Bind variable'], ['style', 'Style'], ['on_message', 'On message (handler)'], ['ref', 'Ref var (optional)']] },
    int_slider:  { label: 'Int slider',   cont: false, props: { props: 'low:0;high:100;', var: 'value', style: '', on_message: '', ref: '' }, fields: [['props', 'Props (low;high)'], ['var', 'Bind variable'], ['style', 'Style'], ['on_message', 'On message (handler)'], ['ref', 'Ref var (optional)']] },
    radio:       { label: 'Radio',        cont: false, props: { items: 'items:Red,Green,Blue;', var: 'choice', style: '', on_message: '', ref: '' }, fields: [['items', 'Options (items:A,B,C;)'], ['var', 'Bind variable'], ['style', 'Style'], ['on_message', 'On message (handler)'], ['ref', 'Ref var (optional)']] },
    icon_button: { label: 'Icon button',  cont: false, props: { props: 'icon_index:1;', style: '' }, fields: [['props', 'Props (icon_index:N;)'], ['style', 'Style']] },
    // Engine console widgets & console setup (see plan): placed by name, plus the
    // whole-console presets and cinematic camera.
    layout_widget:   { label: 'Engine widget',  cont: false, props: { widget: '2dview' }, fields: [['widget', 'Engine widget name']] },
    console_preset:  { label: 'Console preset',  cont: false, props: { console: 'helm' }, fields: [['console', 'Console (helm/weapons/…)']] },
    activate_console:{ label: 'Activate console',cont: false, props: { name: 'cinematic' }, fields: [['name', 'Console name']] },
    cinematic:       { label: 'Cinematic camera',cont: false, props: { mode: 'auto', args: '' }, fields: [['mode', 'Mode (auto/full)'], ['args', 'Full args: camera, offset, target, offset']] },
    // A line the editor didn't recognise (kept verbatim); still editable/deletable.
    raw:             { label: 'Raw line',        cont: false, props: { line: '' }, fields: [['line', 'MAST line (verbatim)']] },
  };

  // --- code generation: model -> MAST lines ---
  function q(s) { return String(s == null ? '' : s); }
  function textProps(p) { let s = '$text:' + q(p.text) + ';'; if (p.style) { s += q(p.style); } return s; }
  function pad(n) { let s = ''; for (let i = 0; i < n; i++) { s += '    '; } return s; }
  function body(n, ind) { const g = gen(n.children, ind); return g.length ? g : [pad(ind) + 'gui_blank()']; }
  // Interactive controls can carry an `on gui_message(<ref>)` handler; when they
  // do, the control line becomes an assignment `<ref> = gui_...`. `ref` is the
  // author's variable, else a stable auto name from the node id.
  const INTERACTIVE = { checkbox: 1, slider: 1, int_slider: 1, input: 1, dropdown: 1, radio: 1 };
  function refOf(n) { const p = n.props || {}; return (p.on_message || p.ref) ? (p.ref || ('w' + n.id)) : ''; }
  function pre(n) { const r = refOf(n); return r ? (r + ' = ') : ''; }
  function gen(nodes, ind) {
    let out = [];
    for (const n of nodes) {
      const p = n.props;
      switch (n.type) {
        case 'section': out.push(pad(ind) + 'gui_section("area: ' + q(p.area) + ';' + q(p.style) + '")'); out = out.concat(gen(n.children, ind)); break;
        case 'row': out.push(pad(ind) + 'gui_row("' + q(p.style) + '")'); out = out.concat(gen(n.children, ind)); break;
        case 'sub_section': out.push(pad(ind) + 'with gui_sub_section("' + q(p.style) + '"):'); out = out.concat(body(n, ind + 1)); break;
        case 'grid': out.push(pad(ind) + 'with gui_grid(' + q(p.columns) + '):'); out = out.concat(body(n, ind + 1)); break;
        case 'list': {
          let a = 'gui_list(' + q(p.items);
          if (p.select === 'true') { a += ', select=True'; }
          if (p.title) { a += ', title="' + q(p.title) + '"'; }
          if (p.row_height) { a += ', row_height="' + q(p.row_height) + '"'; }
          a += ') as ' + (q(p.as) || 'item') + ':';
          out.push(pad(ind) + 'with ' + a); out = out.concat(body(n, ind + 1)); break;
        }
        case 'text': out.push(pad(ind) + 'gui_text("' + textProps(p) + '")'); break;
        case 'button': {
          // The click handler is emitted separately as an `on gui_message(...)`
          // block (see generate) — gui_button itself takes no `:` block.
          let a = pre(n) + 'gui_button("' + q(p.text) + '"';   // `<ref> = ` when the button is matched by ref
          if (p.style) { a += ', "' + q(p.style) + '"'; }
          out.push(pad(ind) + a + ')');
          break;
        }
        case 'checkbox': out.push(pad(ind) + pre(n) + 'gui_checkbox("' + q(p.props) + '", "' + q(p.style) + '")'); break;
        case 'slider': out.push(pad(ind) + pre(n) + 'gui_slider("' + q(p.props) + '", "' + q(p.style) + '")'); break;
        case 'input': out.push(pad(ind) + pre(n) + 'gui_input("", var="' + q(p.var) + '")'); break;
        case 'face': out.push(pad(ind) + 'gui_face(' + q(p.var) + ')'); break;
        case 'icon': out.push(pad(ind) + 'gui_icon("' + q(p.props) + '", "' + q(p.style) + '")'); break;
        case 'image': out.push(pad(ind) + 'gui_image("' + q(p.props) + '", "' + q(p.style) + '")'); break;
        case 'blank': out.push(pad(ind) + 'gui_blank(' + q(p.count) + ')'); break;
        case 'text_area': out.push(pad(ind) + 'gui_text_area("' + q(p.text) + '"' + (p.style ? ', "' + q(p.style) + '"' : '') + ')'); break;
        case 'ship': out.push(pad(ind) + 'gui_ship("' + q(p.props) + '"' + (p.style ? ', "' + q(p.style) + '"' : '') + ')'); break;
        case 'dropdown': out.push(pad(ind) + pre(n) + 'gui_drop_down("' + q(p.items) + '", var="' + q(p.var) + '")'); break;
        case 'int_slider': out.push(pad(ind) + pre(n) + 'gui_int_slider("' + q(p.props) + '", var="' + q(p.var) + '")'); break;
        case 'radio': out.push(pad(ind) + pre(n) + 'gui_radio("' + q(p.items) + '", var="' + q(p.var) + '")'); break;
        case 'icon_button': out.push(pad(ind) + 'gui_icon_button("' + q(p.props) + '", "' + q(p.style) + '")'); break;
        case 'layout_widget': out.push(pad(ind) + 'gui_layout_widget("' + q(p.widget) + '")'); break;
        case 'console_preset': out.push(pad(ind) + 'gui_console("' + q(p.console) + '")'); break;
        case 'activate_console': out.push(pad(ind) + 'gui_activate_console("' + q(p.name) + '")'); break;
        case 'cinematic': out.push(pad(ind) + (p.mode === 'full' ? 'gui_cinematic_full_control(client_id, ' + q(p.args) + ')' : 'gui_cinematic_auto(client_id)')); break;
        case 'table': {
          let a = 'gui_table(' + q(p.items);
          if (p.headers) { a += ', headers=[' + q(p.headers).split(',').map(function (h) { return '"' + h.trim() + '"'; }).join(', ') + ']'; }
          if (p.select === 'true') { a += ', select=True'; }
          a += ') as ' + (q(p.as) || 'row') + ':';
          out.push(pad(ind) + 'with ' + a); out = out.concat(body(n, ind + 1)); break;
        }
        case 'raw': out.push(pad(ind) + q(p.line)); break;
      }
    }
    return out;
  }
  // Handlers emit an `on gui_message(...)` block. A button matches by its ref var
  // when it has one (assignment form), else by its label; other controls always
  // match by ref.
  function collectHandlers(nodes, out) {
    for (const n of nodes) {
      const p = n.props || {};
      if (n.type === 'button' && q(p.on_click)) {
        const r = refOf(n);
        out.push({ head: r ? r : ('gui_button("' + q(p.text) + '")'), body: p.on_click });
      } else if (INTERACTIVE[n.type] && q(p.on_message)) {
        out.push({ head: refOf(n), body: p.on_message });
      }
      if (n.children) { collectHandlers(n.children, out); }
    }
    return out;
  }
  // A complete, presentable gui UNDER ITS OWN LABEL (a gui must never sit in the
  // implicit `main`): `=== <label>` then the indented layout, on gui_message
  // handler blocks, and a trailing `await gui()`.
  function generate(model) {
    const lines = gen(model.children, 0);
    if (!lines.length) { return ''; }
    collectHandlers(model.children, []).forEach(function (h) {
      lines.push('on gui_message(' + h.head + '):');
      q(h.body).split('\n').forEach(function (ln) { lines.push('    ' + ln); });
    });
    lines.push('await gui()');
    const web = !!(model.props && model.props.web);
    const label = (model.props && model.props.label) || (web ? 'page' : 'my_gui');
    const head = web ? ('//web/' + label) : ('=== ' + label);   // a web page is a //web/<path> route
    return head + '\n' + lines.map(function (l) { return l ? '    ' + l : l; }).join('\n');
  }

  // --- round-trip parse: MAST lines -> model ---
  function indentOf(s) { let n = 0; while (s.charAt(n) === ' ') { n++; } return n; }
  function parseTextProps(s) { const m = s.match(/^\$text:([\s\S]*?);([\s\S]*)$/); return m ? { text: m[1], style: m[2] } : { text: s, style: '' }; }
  function parseListArgs(s) {
    const p = { items: '', as: 'item', select: 'false', title: '', row_height: '' };
    const ci = s.indexOf(',');
    if (ci >= 0) {
      p.items = s.slice(0, ci).trim();
      const rest = s.slice(ci + 1);
      if (/select\s*=\s*True/.test(rest)) { p.select = 'true'; }
      const tm = rest.match(/title\s*=\s*"([^"]*)"/); if (tm) { p.title = tm[1]; }
      const rm = rest.match(/row_height\s*=\s*"([^"]*)"/); if (rm) { p.row_height = rm[1]; }
    } else { p.items = s.trim(); }
    return p;
  }
  // Strip a leading `<ref> = ` off an interactive-control line (the assignment form
  // used with `on gui_message(<ref>)`), remember the ref, then parse the control.
  function parseLine(s) {
    let ref = '';
    const am = s.match(/^([A-Za-z_]\w*)\s*=\s*(gui_(?:button|checkbox|slider|int_slider|input|drop_down|radio)\(.*)$/);
    if (am) { ref = am[1]; s = am[2]; }
    const r = parseLineInner(s);
    if (ref && r && r.props) { r.props.ref = ref; }
    return r;
  }
  function parseLineInner(s) {
    let m;
    if ((m = s.match(/^gui_section\("area:\s*([^;]*);?([\s\S]*)"\)$/))) { return { type: 'section', props: { area: m[1].trim(), style: m[2] } }; }
    if ((m = s.match(/^gui_row\("(.*)"\)$/))) { return { type: 'row', props: { style: m[1] } }; }
    if ((m = s.match(/^with gui_sub_section\("(.*)"\):$/))) { return { type: 'sub_section', with: true, props: { style: m[1] } }; }
    if ((m = s.match(/^with gui_grid\((.+?)\):$/))) { return { type: 'grid', with: true, props: { columns: m[1].trim() } }; }
    if ((m = s.match(/^with gui_list\((.+)\) as (\w+):$/))) { const p = parseListArgs(m[1]); p.as = m[2]; return { type: 'list', with: true, props: p }; }
    if ((m = s.match(/^with gui_table\((.+)\) as (\w+):$/))) {
      const inner = m[1]; const ci = inner.indexOf(',');
      const p = { items: (ci >= 0 ? inner.slice(0, ci) : inner).trim(), headers: '', as: m[2], select: 'false' };
      const rest = ci >= 0 ? inner.slice(ci + 1) : '';
      if (/select\s*=\s*True/.test(rest)) { p.select = 'true'; }
      const hm = rest.match(/headers\s*=\s*\[([^\]]*)\]/);
      if (hm) { p.headers = hm[1].split(',').map(function (x) { return x.trim().replace(/^["']|["']$/g, ''); }).filter(function (x) { return x !== ''; }).join(', '); }
      return { type: 'table', with: true, props: p };
    }
    if ((m = s.match(/^on gui_message\(gui_button\("(.*?)"\)\):$/))) { return { type: '__onmsg__', target: m[1], handler: true }; }
    if ((m = s.match(/^on gui_message\((\w+)\):$/))) { return { type: '__onmsg__', ref: m[1], handler: true }; }
    if ((m = s.match(/^gui_text\("(.*)"\)$/))) { return { type: 'text', props: parseTextProps(m[1]) }; }
    if ((m = s.match(/^gui_button\("(.*?)"(?:,\s*"(.*)")?\)$/))) { return { type: 'button', props: { text: m[1], style: m[2] || '', on_click: '' } }; }
    if ((m = s.match(/^gui_checkbox\("(.*)",\s*"(.*)"\)$/))) { return { type: 'checkbox', props: { props: m[1], style: m[2] } }; }
    if ((m = s.match(/^gui_slider\("(.*)",\s*"(.*)"\)$/))) { return { type: 'slider', props: { props: m[1], style: m[2] } }; }
    if ((m = s.match(/^gui_icon\("(.*)",\s*"(.*)"\)$/))) { return { type: 'icon', props: { props: m[1], style: m[2] } }; }
    if ((m = s.match(/^gui_image\("(.*)",\s*"(.*)"\)$/))) { return { type: 'image', props: { props: m[1], style: m[2] } }; }
    if ((m = s.match(/^gui_input\("",\s*var="(.+?)"\)$/))) { return { type: 'input', props: { var: m[1], style: '' } }; }
    if ((m = s.match(/^gui_face\((.+?)\)$/))) { return { type: 'face', props: { var: m[1], style: '' } }; }
    if ((m = s.match(/^gui_blank\((.+?)\)$/))) { return { type: 'blank', props: { count: m[1] } }; }
    // Engine widgets (round-trip the same forms generate() emits).
    if ((m = s.match(/^gui_text_area\("(.*?)"(?:,\s*"(.*)")?\)$/))) { return { type: 'text_area', props: { text: m[1], style: m[2] || '' } }; }
    if ((m = s.match(/^gui_ship\("(.*?)"(?:,\s*"(.*)")?\)$/))) { return { type: 'ship', props: { props: m[1], style: m[2] || '' } }; }
    if ((m = s.match(/^gui_drop_down\("(.*)",\s*var="(.*?)"\)$/))) { return { type: 'dropdown', props: { items: m[1], var: m[2], style: '' } }; }
    if ((m = s.match(/^gui_int_slider\("(.*)",\s*var="(.*?)"\)$/))) { return { type: 'int_slider', props: { props: m[1], var: m[2], style: '' } }; }
    if ((m = s.match(/^gui_radio\("(.*)",\s*var="(.*?)"\)$/))) { return { type: 'radio', props: { items: m[1], var: m[2], style: '' } }; }
    if ((m = s.match(/^gui_icon_button\("(.*)",\s*"(.*)"\)$/))) { return { type: 'icon_button', props: { props: m[1], style: m[2] } }; }
    // Engine console widgets & console setup.
    if ((m = s.match(/^gui_layout_widget\("(.*)"\)$/))) { return { type: 'layout_widget', props: { widget: m[1] } }; }
    if ((m = s.match(/^gui_console\("(.*)"\)$/))) { return { type: 'console_preset', props: { console: m[1] } }; }
    if ((m = s.match(/^gui_activate_console\("(.*)"\)$/))) { return { type: 'activate_console', props: { name: m[1] } }; }
    if ((m = s.match(/^gui_cinematic_auto\(client_id\)$/))) { return { type: 'cinematic', props: { mode: 'auto', args: '' } }; }
    if ((m = s.match(/^gui_cinematic_full_control\(client_id,\s*(.*)\)$/))) { return { type: 'cinematic', props: { mode: 'full', args: m[1] } }; }
    // Declarative gui_table(items, [cols]) is kept verbatim as 'raw' (the editor's
    // table is the `with` block form above).
    return { type: 'raw', props: { line: s } };
  }
  function parseStatements(lines, i, base) {
    const out = [];
    while (i < lines.length) {
      const raw = lines[i];
      const t = raw.trim();
      if (!t || t === '# (nothing yet)' || t === 'await gui()') { i++; continue; }   // blanks / placeholder / trailing present
      const ind = indentOf(raw);
      if (ind < base) { break; }
      if (ind > base) { i++; continue; }
      const st = parseLine(t); i++;
      if (st.with) { const r = parseStatements(lines, i, base + 4); st.children = r.out; i = r.i; }
      else if (st.handler) {                       // on gui_message(...) — capture its body verbatim
        const body = [];
        while (i < lines.length && (lines[i].trim() === '' || indentOf(lines[i]) > base)) {
          if (lines[i].trim() !== '') { body.push(lines[i].slice(base + 4)); }
          i++;
        }
        st.body = body.join('\n');
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
    // A leading `=== <label>` names a gui; `//web/<path>` names a web page. Its
    // body is indented one level.
    let start = 0, base = 0, label = 'my_gui', web = false;
    const wm = (lines[0] || '').match(/^\/\/web\/(\S+)/);
    if (wm) { label = wm[1]; web = true; start = 1; base = 4; }
    else { const lm = (lines[0] || '').match(/^===+\s*(\w+)/); if (lm) { label = lm[1]; start = 1; base = 4; } }
    const r = parseStatements(lines, start, base);
    const rootNode = { id: 0, type: 'root', props: { label: label, web: web }, children: [] };
    // Handlers (on gui_message) sit after the layout — pull them out, build the
    // layout, then attach each handler's body to its button as on_click.
    const handlers = [];
    const layout = r.out.filter(function (st) {
      if (st.type === '__onmsg__') { handlers.push(st); return false; }
      return true;
    });
    buildFlow(layout, rootNode.children);
    handlers.forEach(function (h) {
      let ok = false;
      if (h.ref) {                                   // on gui_message(<ref>) — button (on_click) or control (on_message)
        const c = findByRef(rootNode, h.ref);
        if (c) { if (c.type === 'button') { c.props.on_click = h.body || ''; } else { c.props.on_message = h.body || ''; } ok = true; }
      } else {                                        // on gui_message(gui_button("X")) — by label
        const b = findButton(rootNode, h.target);
        if (b) { b.props.on_click = h.body || ''; ok = true; }
      }
      if (!ok) {                                      // target isn't a modeled control — keep the block verbatim rather than drop it
        const head = h.ref ? ('on gui_message(' + h.ref + '):') : ('on gui_message(gui_button("' + h.target + '")):');
        rootNode.children.push({ id: ++idc, type: 'raw', props: { line: head } });
        (h.body || '').split('\n').forEach(function (bl) { rootNode.children.push({ id: ++idc, type: 'raw', props: { line: '    ' + bl } }); });
      }
    });
    return { model: rootNode, nextId: idc };
  }

  function findButton(node, text) {
    if (node.type === 'button' && node.props.text === text) { return node; }
    for (const c of (node.children || [])) { const f = findButton(c, text); if (f) { return f; } }
    return null;
  }
  function findByRef(node, ref) {
    if (node.props && node.props.ref === ref) { return node; }
    for (const c of (node.children || [])) { const f = findByRef(c, ref); if (f) { return f; } }
    return null;
  }

  return { CAT: CAT, gen: gen, generate: generate, parse: parse };
});
