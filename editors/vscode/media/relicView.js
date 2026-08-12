// The Relic Editor's view: a relic model in, an HTML page out.
//
// Split out of extension.ts so it can be RUN. It is a pure function - no vscode, no DOM,
// no I/O - so a plain node test can assert that a chamber lands at the coordinates it was
// authored at, which is the half of this editor that unit tests can actually reach.
// Everything else (does the drag feel right, does the panel look right) needs an
// Extension Development Host and an eye.
//
// The plan is XZ, top-down, with height carried as a label rather than a third axis.
// SVG user units ARE world units - the viewBox is set to the relic's own bounds - so a
// drag delta needs no conversion beyond the CTM inverse.

'use strict';

/** How far a part reaches on the plan, for framing. */
function extent(p) {
  if (p.kind === 'chamber') return p.r || 200;
  if (p.kind === 'box') return Math.max(p.hx || 0, p.hz || 0) || 200;
  if (p.shape === 'capsule') {
    const half = Math.max(Math.abs((p.bx - p.ax) / 2), Math.abs((p.bz - p.az) / 2));
    return half + (p.r || 100);
  }
  return p.r || 100;
}


/**
 * Which parts share a spot on the plan, and in what order to stack their labels.
 *
 * A top-down plan cannot show a vertical stack: a shaft directly above a hub is the SAME
 * DOT, and without this their names and readouts print on top of each other into mush.
 * Returns key -> row index, ordered by height so the labels read like an elevation with
 * the highest chamber on top.
 */
function stackRows(parts) {
  const groups = new Map();
  for (const p of parts) {
    const k = Math.round(p.x) + ':' + Math.round(p.z);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }
  const rows = new Map();
  for (const g of groups.values()) {
    g.sort((a, b) => (b.y || 0) - (a.y || 0));
    g.forEach((p, i) => rows.set(p.key, { row: i, of: g.length }));
  }
  return rows;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Render the plan.
 *
 * `relics` is relicModel.parse(...).relics; `index` picks which one.
 * Returns a complete HTML document for a webview.
 */
function render(relics, nonce, index) {
  const rel = relics[index];
  if (!rel) {
    return '<!DOCTYPE html><html><body style="font-family:var(--vscode-font-family);'
      + 'color:var(--vscode-foreground);padding:12px"><p>No relic in this file.</p>'
      + '<p style="opacity:.7">A relic is a record in a <code>Relics</code> section '
      + 'carrying a <code>Loc:</code>; its chambers are records carrying '
      + '<code>Relic:</code>.</p></body></html>';
  }
  const placed = [].concat(rel.chambers, rel.boxes, rel.solids);
  const xs = [0];
  const zs = [0];
  for (const p of placed) {
    const e = extent(p);
    xs.push(p.x - e, p.x + e);
    zs.push(p.z - e, p.z + e);
  }
  const minX = Math.min.apply(null, xs) - 400;
  const maxX = Math.max.apply(null, xs) + 400;
  const minZ = Math.min.apply(null, zs) - 400;
  const maxZ = Math.max.apply(null, zs) + 400;
  const w = Math.max(maxX - minX, 1);
  const h = Math.max(maxZ - minZ, 1);
  const fs = Math.max(w, h) / 42;

  const byKey = new Map([].concat(rel.chambers, rel.boxes).map((p) => [p.key, p]));
  const rows = stackRows([].concat(rel.chambers, rel.boxes));
  let svg = '';

  // Passages first, so a chamber is never hidden behind a corridor.
  for (const p of rel.passages) {
    const a = byKey.get(p.from);
    const b = byKey.get(p.to);
    if (!a || !b) continue;         // dangling: the linter reports it, the plan omits it
    svg += '<line x1="' + a.x + '" y1="' + a.z + '" x2="' + b.x + '" y2="' + b.z
      + '" stroke="#7aa2f7" stroke-width="' + ((p.radius == null ? 200 : p.radius) * 2)
      + '" stroke-opacity="0.30" stroke-linecap="round"/>';
  }
  for (const c of rel.chambers) {
    const st = rows.get(c.key) || { row: 0, of: 1 };
    // One label block per part, pushed down a line for each part already at this spot.
    const top = (0 - fs * 0.9) + st.row * fs * 2.0;
    const stacked = st.of > 1;
    svg += '<g class="part" data-key="' + esc(c.key) + '" data-kind="chamber">'
      + '<circle cx="' + c.x + '" cy="' + c.z + '" r="' + c.r + '" fill="#7aa2f7"'
      + ' fill-opacity="0.16" stroke="#7aa2f7" stroke-width="6"/>'
      + (stacked
        // A leader line, so a fanned label is visibly tied to the dot it belongs to.
        ? '<line x1="' + c.x + '" y1="' + c.z + '" x2="' + c.x + '" y2="' + (c.z + top)
          + '" stroke="#7aa2f7" stroke-opacity="0.35" stroke-width="2"/>' : '')
      + '<text x="' + c.x + '" y="' + c.z + '" text-anchor="middle" dy="' + top
      + '" font-size="' + fs + '" fill="var(--vscode-foreground)">'
      + esc(c.name || c.key) + '</text>'
      + '<text x="' + c.x + '" y="' + c.z + '" text-anchor="middle" dy="'
      + (top + fs * 0.85) + '" font-size="' + (fs * 0.66)
      + '" fill="var(--vscode-descriptionForeground)">y ' + c.y + '  r ' + c.r
      + '</text></g>';
  }
  for (const b of rel.boxes) {
    svg += '<g class="part" data-key="' + esc(b.key) + '" data-kind="box">'
      + '<rect x="' + (b.x - (b.hx || 0)) + '" y="' + (b.z - (b.hz || 0)) + '" width="'
      + ((b.hx || 0) * 2) + '" height="' + ((b.hz || 0) * 2)
      + '" fill="#9ece6a" fill-opacity="0.16" stroke="#9ece6a" stroke-width="6"/>'
      + '<text x="' + b.x + '" y="' + b.z + '" text-anchor="middle" dy="'
      + ((0 - fs * 0.9) + ((rows.get(b.key) || { row: 0 }).row * fs * 2.0))
      + '" font-size="' + fs + '" fill="var(--vscode-foreground)">'
      + esc(b.name || b.key) + '</text></g>';
  }
  for (const s of rel.solids) {
    // Subtracted space is drawn dashed and warm, so it reads as "not room" at a glance.
    svg += '<g class="part" data-key="' + esc(s.key) + '" data-kind="solid">';
    if (s.shape === 'capsule') {
      svg += '<line x1="' + s.ax + '" y1="' + s.az + '" x2="' + s.bx + '" y2="' + s.bz
        + '" stroke="#f7768e" stroke-opacity="0.45" stroke-width="' + ((s.r || 100) * 2)
        + '" stroke-linecap="round"/>';
    } else if (s.shape === 'box') {
      svg += '<rect x="' + (s.x - (s.hx || 0)) + '" y="' + (s.z - (s.hz || 0))
        + '" width="' + ((s.hx || 0) * 2) + '" height="' + ((s.hz || 0) * 2)
        + '" fill="#f7768e" fill-opacity="0.30" stroke="#f7768e" stroke-width="6"'
        + ' stroke-dasharray="18 10"/>';
    } else {
      svg += '<circle cx="' + s.x + '" cy="' + s.z + '" r="' + (s.r || 100)
        + '" fill="#f7768e" fill-opacity="0.30" stroke="#f7768e" stroke-width="6"'
        + ' stroke-dasharray="18 10"/>';
    }
    svg += '</g>';
  }

  const picker = relics.length > 1
    ? '<select id="pick">' + relics.map((r, i) => '<option value="' + i + '"'
        + (i === index ? ' selected' : '') + '>' + esc(r.name || r.key) + '</option>')
        .join('') + '</select>'
    : '<b>' + esc(rel.name || rel.key) + '</b>';
  const warn = rel.orphans.length
    ? '<div class="warn">' + rel.orphans.length
      + ' part(s) name a relic that does not exist &mdash; they are not built.</div>' : '';

  const style = 'body{margin:0;font-family:var(--vscode-font-family);'
    + 'color:var(--vscode-foreground);background:var(--vscode-editor-background);'
    + 'display:flex;flex-direction:column;height:100vh}'
    + 'header{padding:8px 10px;border-bottom:1px solid var(--vscode-panel-border,#8883);'
    + 'display:flex;gap:10px;align-items:center}'
    + '.hint{font-size:11px;color:var(--vscode-descriptionForeground)}'
    + '.warn{font-size:11px;color:var(--vscode-editorWarning-foreground,#e0af68);'
    + 'padding:4px 10px}.wrap{flex:1;overflow:auto}'
    + 'svg{display:block;width:100%;height:100%}'
    + '.part{cursor:grab}.part.sel circle,.part.sel rect{stroke-width:12}';

  const script = "const vscode=acquireVsCodeApi();"
    + "const svg=document.getElementById('plan');let drag=null;"
    + "function pt(e){const p=svg.createSVGPoint();p.x=e.clientX;p.y=e.clientY;"
    + "return p.matrixTransform(svg.getScreenCTM().inverse());}"
    + "svg.addEventListener('mousedown',function(e){"
    + "const g=e.target.closest('.part');if(!g)return;const p=pt(e);"
    + "drag={key:g.dataset.key,g:g,x0:p.x,z0:p.y,dx:0,dz:0,moved:false};"
    + "document.querySelectorAll('.part.sel').forEach(function(n){n.classList.remove('sel');});"
    + "g.classList.add('sel');});"
    + "window.addEventListener('mousemove',function(e){if(!drag)return;const p=pt(e);"
    + "drag.dx=p.x-drag.x0;drag.dz=p.y-drag.z0;"
    + "if(Math.abs(drag.dx)+Math.abs(drag.dz)>1)drag.moved=true;"
    + "drag.g.setAttribute('transform','translate('+drag.dx+','+drag.dz+')');});"
    + "window.addEventListener('mouseup',function(){if(!drag)return;"
    // A click to SELECT must never touch the file - only a real move writes.
    + "if(drag.moved)vscode.postMessage({type:'move',key:drag.key,dx:drag.dx,dz:drag.dz});"
    + "drag.g.removeAttribute('transform');drag=null;});"
    + "const pick=document.getElementById('pick');"
    + "if(pick)pick.addEventListener('change',function(){"
    + "vscode.postMessage({type:'pick',index:Number(pick.value)});});";

  return '<!DOCTYPE html><html><head><meta charset="utf-8">'
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; '
    + 'style-src \'unsafe-inline\'; script-src \'nonce-' + nonce + '\';">'
    + '<style>' + style + '</style></head><body>'
    + '<header>' + picker + '<span class="hint">drag a chamber to move it &middot; '
    + 'the file updates as you drop</span></header>' + warn
    + '<div class="wrap"><svg id="plan" viewBox="' + minX + ' ' + minZ + ' ' + w + ' ' + h
    + '" preserveAspectRatio="xMidYMid meet"><g>' + svg + '</g></svg></div>'
    + '<script nonce="' + nonce + '">' + script + '</script></body></html>';
}

module.exports = { render, extent, stackRows };
