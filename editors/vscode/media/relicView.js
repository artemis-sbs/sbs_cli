// The Relic Editor's view: a relic model in, an HTML page out.
//
// Split out of extension.ts so it can be RUN. It is a pure function - no vscode, no DOM,
// no I/O - so a plain node test can assert that a chamber lands at the coordinates it was
// authored at, which is the half of this editor that unit tests can actually reach.
// Everything else (does the drag feel right, does the panel look right) needs an
// Extension Development Host and an eye. Two bugs so far were visible only on screen.
//
// The plan is XZ, top-down, with height carried as a label rather than a third axis.
//
// +Z IS UP, matching the game's radar - client.html projects `toY: wz => cyp - (wz - cz)
// * scale` with the comment "+Z up". SVG's y axis grows DOWNWARD, so every world z is
// negated on the way in (`sy`) and every drag delta is negated on the way back out.
// Getting this backwards mirrors the whole relic, which looks plausible and is wrong -
// a chamber authored north of the hub would sit south of it on the plan.
//
// Apart from that flip, SVG user units ARE world units - the viewBox is the relic's own
// bounds - so a drag needs no conversion beyond the CTM inverse.
//
// The reference GRID is a square 1000u/10000u lattice, matching the game's 2D view, so a
// chamber radius can be counted off the plan instead of read off a label. Pan and zoom
// follow the same view's gestures - drag to pan, wheel to zoom, DOUBLE-CLICK TO RESET -
// so the muscle memory carries over. (The browser mock's 3D grids use 5000u cells; these
// are the 2D view's numbers.)

'use strict';

const V3 = require('./relicView3d.js');
const Orbit = require('./relicOrbit.js');

/** World z -> SVG y. The radar draws +Z up; SVG grows down. */
function sy(z) { return 0 - z; }

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

// Grid spacing, matching the game's own views: a minor line every 1000 units and a major
// every 10000, so a chamber radius can be counted off the plan rather than read off a
// label. (The browser mock's 3D grids use 5000u cells; these are the 2D view's numbers.)
const GRID_MINOR = 1000;
const GRID_MAJOR = 10000;

// The engine's `render-distance-objects`. A relic wider than this stops drawing its own
// far side, which is why the demo layout keeps neighbouring chambers well inside it.
// Measured against the ENGINE, not chosen: it is a setting, so it is named here once
// rather than sprinkled through the drawing code.
const RENDER_DISTANCE = 5000;

/** 3D distance between two parts. A passage that reads short on a top-down plan can be
 *  almost entirely vertical, so the plan's own geometry is the wrong thing to measure. */
function span(a, b) {
  const dx = a.x - b.x, dy = (a.y || 0) - (b.y || 0), dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Grid lines for a span, thinned out so a huge relic does not become solid ink. */
function gridLines(min, max, step) {
  const out = [];
  if ((max - min) / step > 400) return out;      // absurd density helps nobody
  const first = Math.ceil(min / step) * step;
  for (let v = first; v <= max; v += step) out.push(v);
  return out;
}

/**
 * Which parts share a spot on the plan, and in what order to stack their labels.
 *
 * A top-down plan cannot show a vertical stack: a shaft directly above a hub is the SAME
 * DOT, and without this their names and readouts print on top of each other into mush.
 * Returns key -> row, ordered by height so the labels read like an elevation.
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

/** The relic's own bounds, before any zoom or pan. */
function bounds(rel) {
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
  // The viewBox is in SVG space, so the flip swaps which end is the top.
  return { x: minX, y: sy(maxZ), w: Math.max(maxX - minX, 1),
           h: Math.max(maxZ - minZ, 1) };
}

/**
 * Render the plan.
 *
 * `view` is an optional {x, y, w, h} viewBox - the webview reports its own after a zoom
 * or pan so the panel can be redrawn without throwing away where you were looking. A
 * redraw happens on every keystroke in the document, so losing it would make the plan
 * unusable while editing.
 */
function render(relics, nonce, index, view, live, mode, cam) {
  const rel = relics[index];
  if (!rel) {
    return '<!DOCTYPE html><html><body style="font-family:var(--vscode-font-family);'
      + 'color:var(--vscode-foreground);padding:12px"><p>No relic in this file.</p>'
      + '<p style="opacity:.7">A relic is a record in a <code>Relics</code> section '
      + 'carrying a <code>Loc:</code>; its chambers are records carrying '
      + '<code>Relic:</code>.</p></body></html>';
  }
  const base = bounds(rel);
  const vb = (view && isFinite(view.w) && view.w > 0) ? view : base;
  const fs = Math.max(base.w, base.h) / 42;

  // The 3D camera and its framing. `view` is shared between the two modes on purpose:
  // each reports its own viewBox and the panel hands back whichever was last seen, so
  // switching Plan/3D does not throw away where you were looking.
  const cam3 = cam || V3.defaultCamera();
  const e3 = V3.extent(V3.scene(rel, cam3));
  const pad3 = Math.max(e3.w, e3.h) * 0.08;
  const v3 = (view && isFinite(view.w) && view.w > 0)
    ? view
    : { x: e3.x - pad3, y: e3.y - pad3, w: e3.w + pad3 * 2, h: e3.h + pad3 * 2 };

  // ---- reference grid ------------------------------------------------------
  // Drawn over the relic's own bounds rather than the current view, so panning moves the
  // world under a grid that stays put in world space - which is what makes it a ruler.
  const gx0 = base.x;
  const gx1 = base.x + base.w;
  const gz0 = base.y;
  const gz1 = base.y + base.h;
  const thin = Math.max(base.w, base.h) / 2000;
  let grid = '<g class="grid" pointer-events="none">';
  for (const v of gridLines(gx0, gx1, GRID_MINOR)) {
    const major = (v % GRID_MAJOR) === 0;
    grid += '<line x1="' + v + '" y1="' + gz0 + '" x2="' + v + '" y2="' + gz1
      + '" stroke="#8f98c8" stroke-opacity="' + (major ? '0.30' : '0.10')
      + '" stroke-width="' + (thin * (major ? 2 : 1)) + '"/>';
  }
  // gz0/gz1 are already SVG y, so these lines are drawn directly - but their WORLD
  // value is the negation, which is what decides whether a line is major.
  for (const v of gridLines(gz0, gz1, GRID_MINOR)) {
    const major = (sy(v) % GRID_MAJOR) === 0;
    grid += '<line x1="' + gx0 + '" y1="' + v + '" x2="' + gx1 + '" y2="' + v
      + '" stroke="#8f98c8" stroke-opacity="' + (major ? '0.30' : '0.10')
      + '" stroke-width="' + (thin * (major ? 2 : 1)) + '"/>';
  }
  // Label the major lines, so the ruler says what it is measuring.
  for (const v of gridLines(gx0, gx1, GRID_MAJOR)) {
    if (v === 0) continue;
    grid += '<text x="' + v + '" y="' + gz0 + '" dy="' + (fs * 0.9) + '" font-size="'
      + (fs * 0.6) + '" fill="#8f98c8" fill-opacity="0.6" text-anchor="middle">'
      + v + '</text>';
  }
  grid += '</g>';

  const byKey = new Map([].concat(rel.chambers, rel.boxes).map((p) => [p.key, p]));
  const rows = stackRows([].concat(rel.chambers, rel.boxes));
  let svg = '';

  // Passages first, so a chamber is never hidden behind a corridor.
  const tooFar = [];
  for (const p of rel.passages) {
    const a = byKey.get(p.from);
    const b = byKey.get(p.to);
    if (!a || !b) continue;         // dangling: the linter reports it, the plan omits it
    // A corridor longer than the engine's render distance goes dark at the far end:
    // stand in one chamber and the other simply is not drawn. Measured in 3D, because
    // a passage that looks short on a top-down plan can be mostly vertical.
    const far = span(a, b) > RENDER_DISTANCE;
    if (far) { tooFar.push(p.from + ' - ' + p.to + ' (' + Math.round(span(a, b)) + 'u)'); }
    svg += '<line x1="' + a.x + '" y1="' + sy(a.z) + '" x2="' + b.x + '" y2="' + sy(b.z)
      + '" stroke="' + (far ? '#e0af68' : '#7aa2f7') + '" stroke-width="'
      + ((p.radius == null ? 200 : p.radius) * 2)
      + '" stroke-opacity="0.30" stroke-linecap="round"'
      + (far ? ' stroke-dasharray="600 400"' : '')
      + '><title>' + esc(p.from + ' - ' + p.to) + ': ' + Math.round(span(a, b)) + 'u'
      + (far ? ' - past the ' + RENDER_DISTANCE + 'u render distance, so the far end '
             + 'stops drawing' : '') + '</title></line>';
  }
  for (const c of rel.chambers) {
    const st = rows.get(c.key) || { row: 0, of: 1 };
    const top = (0 - fs * 0.9) + st.row * fs * 2.0;
    svg += '<g class="part" data-key="' + esc(c.key) + '" data-kind="chamber"'
      + ' data-name="' + esc(c.name || c.key) + '" data-x="' + c.x + '" data-y="'
      + c.y + '" data-z="' + c.z + '" data-r="' + c.r + '">'
      + '<circle cx="' + c.x + '" cy="' + sy(c.z) + '" r="' + c.r + '" fill="#7aa2f7"'
      + ' fill-opacity="0.16" stroke="#7aa2f7" stroke-width="6"/>'
      + (st.of > 1
        // A leader line, so a fanned label is visibly tied to the dot it belongs to.
        ? '<line x1="' + c.x + '" y1="' + sy(c.z) + '" x2="' + c.x + '" y2="' + (sy(c.z) + top)
          + '" stroke="#7aa2f7" stroke-opacity="0.35" stroke-width="2"/>' : '')
      + '<text x="' + c.x + '" y="' + sy(c.z) + '" text-anchor="middle" dy="' + top
      + '" font-size="' + fs + '" fill="var(--vscode-foreground)">'
      + esc(c.name || c.key) + '</text>'
      + '<text x="' + c.x + '" y="' + sy(c.z) + '" text-anchor="middle" dy="'
      + (top + fs * 0.85) + '" font-size="' + (fs * 0.66)
      + '" fill="var(--vscode-descriptionForeground)">y ' + c.y + '  r ' + c.r
      + '</text></g>';
  }
  for (const b of rel.boxes) {
    svg += '<g class="part" data-key="' + esc(b.key) + '" data-kind="box"'
      + ' data-name="' + esc(b.name || b.key) + '" data-x="' + b.x + '" data-y="'
      + b.y + '" data-z="' + b.z + '" data-hx="' + b.hx + '" data-hy="' + b.hy
      + '" data-hz="' + b.hz + '">'
      + '<rect x="' + (b.x - (b.hx || 0)) + '" y="' + (sy(b.z) - (b.hz || 0)) + '" width="'
      + ((b.hx || 0) * 2) + '" height="' + ((b.hz || 0) * 2)
      + '" fill="#9ece6a" fill-opacity="0.16" stroke="#9ece6a" stroke-width="6"/>'
      + '<text x="' + b.x + '" y="' + sy(b.z) + '" text-anchor="middle" dy="'
      + ((0 - fs * 0.9) + ((rows.get(b.key) || { row: 0 }).row * fs * 2.0))
      + '" font-size="' + fs + '" fill="var(--vscode-foreground)">'
      + esc(b.name || b.key) + '</text></g>';
  }
  for (const s of rel.solids) {
    // Subtracted space is drawn dashed and warm, so it reads as "not room" at a glance.
    svg += '<g class="part" data-key="' + esc(s.key) + '" data-kind="solid"'
      + ' data-name="' + esc(s.name || s.key) + '" data-shape="' + esc(s.shape)
      + '" data-x="' + s.x + '" data-y="' + s.y + '" data-z="' + s.z
      + '" data-r="' + (s.r || 0) + '">';
    if (s.shape === 'capsule') {
      svg += '<line x1="' + s.ax + '" y1="' + sy(s.az) + '" x2="' + s.bx + '" y2="' + sy(s.bz)
        + '" stroke="#f7768e" stroke-opacity="0.45" stroke-width="' + ((s.r || 100) * 2)
        + '" stroke-linecap="round"/>';
    } else if (s.shape === 'box') {
      svg += '<rect x="' + (s.x - (s.hx || 0)) + '" y="' + (sy(s.z) - (s.hz || 0))
        + '" width="' + ((s.hx || 0) * 2) + '" height="' + ((s.hz || 0) * 2)
        + '" fill="#f7768e" fill-opacity="0.30" stroke="#f7768e" stroke-width="6"'
        + ' stroke-dasharray="18 10"/>';
    } else {
      svg += '<circle cx="' + s.x + '" cy="' + sy(s.z) + '" r="' + (s.r || 100)
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
  const warn = (rel.orphans.length
    ? '<div class="warn">' + rel.orphans.length
      + ' part(s) name a relic that does not exist &mdash; they are not built.</div>' : '')
    + (tooFar.length
    // Not a lint rule: `sbs lint` deliberately stays out of size judgements, and the
    // number is a SETTING (render-distance-objects), not a correctness claim. But this
    // is where the author is dragging, and a corridor that goes dark at the far end
    // looks like a rendering bug rather than a layout one, so say it here.
    ? '<div class="warn">' + tooFar.length + ' passage(s) longer than the '
      + RENDER_DISTANCE + 'u render distance &mdash; the far end stops drawing: '
      + esc(tooFar.join(', ')) + '</div>' : '');

  const style = 'body{margin:0;font-family:var(--vscode-font-family);'
    + 'color:var(--vscode-foreground);background:var(--vscode-editor-background);'
    + 'display:flex;flex-direction:column;height:100vh}'
    + 'header{padding:8px 10px;border-bottom:1px solid var(--vscode-panel-border,#8883);'
    + 'display:flex;gap:10px;align-items:center}'
    + 'button.on{background:var(--vscode-button-background,#0e639c);'
    + 'color:var(--vscode-button-foreground,#fff);outline:1px solid var(--vscode-focusBorder,#007fd4)}'
    + '.hint{font-size:11px;color:var(--vscode-descriptionForeground)}'
    + '.warn{font-size:11px;color:var(--vscode-editorWarning-foreground,#e0af68);'
    + 'padding:4px 10px}.wrap{flex:1;overflow:hidden}'
    + 'svg{display:block;width:100%;height:100%;cursor:grab}'
    + 'svg.panning{cursor:grabbing}svg.linking{cursor:crosshair}'
    + 'svg#scene3{cursor:move}svg#scene3.orbiting{cursor:grabbing}'
    + 'svg#scene3.panning{cursor:grabbing}'
    + '.part{cursor:move}.part.sel circle,.part.sel rect{stroke-width:12}'
    + '.insp{position:absolute;right:14px;top:56px;z-index:5;padding:8px 10px;'
    + 'background:var(--vscode-editorWidget-background,#252526);border-radius:6px;'
    + 'border:1px solid var(--vscode-panel-border,#8883);box-shadow:0 3px 14px #0007;'
    + 'display:flex;flex-direction:column;gap:4px;font-size:12px;min-width:150px}'
    + '.insp.hidden,label.hidden{display:none}'
    + '.ititle{font-weight:600;margin-bottom:2px}'
    + '.ikind{opacity:.6;font-weight:400}'
    + '.insp label{display:flex;justify-content:space-between;align-items:center;gap:8px}'
    + '.insp input{width:82px;background:var(--vscode-input-background,#3c3c3c);'
    + 'color:var(--vscode-input-foreground,#ccc);border:1px solid '
    + 'var(--vscode-input-border,#5555);border-radius:3px;padding:1px 4px}'
    + '.ihint{opacity:.55;font-size:10px;margin-top:2px}'
    + 'body{position:relative}'
    + 'button{background:var(--vscode-button-secondaryBackground,#444);'
    + 'color:var(--vscode-button-secondaryForeground,#fff);border:none;border-radius:4px;'
    + 'padding:2px 9px;cursor:pointer;font-size:12px}';

  const script = "const vscode=acquireVsCodeApi();"
    + "const svg=document.getElementById('plan');"
    + "const BASE={x:" + base.x + ",y:" + base.y + ",w:" + base.w + ",h:" + base.h + "};"
    + "let vb={x:" + vb.x + ",y:" + vb.y + ",w:" + vb.w + ",h:" + vb.h + "};"
    + "let drag=null,pan=null,link=null;"
    + "function apply(){svg.setAttribute('viewBox',vb.x+' '+vb.y+' '+vb.w+' '+vb.h);}"
    // Report the view up so a redraw (which happens on every keystroke in the document)
    // can restore it instead of snapping back to the whole relic.
    + "function report(){vscode.postMessage({type:'view',x:vb.x,y:vb.y,w:vb.w,h:vb.h});}"
    + "function pt(e){const p=svg.createSVGPoint();p.x=e.clientX;p.y=e.clientY;"
    + "return p.matrixTransform(svg.getScreenCTM().inverse());}"
    + "svg.addEventListener('mousedown',function(e){const g=e.target.closest('.part');"
    + "const p=pt(e);"
    // SHIFT turns a drag from "move this" into "connect these" - the same gesture, and
    // the modifier is what the hint in the header names.
    + "if(g&&e.shiftKey){link={from:g.dataset.key,g:g};svg.classList.add('linking');return;}"
    + "if(g){drag={key:g.dataset.key,g:g,x0:p.x,z0:p.y,dx:0,dz:0,moved:false};"
    + "document.querySelectorAll('.part.sel').forEach(function(n){n.classList.remove('sel');});"
    + "g.classList.add('sel');show(g);}"
    // Dragging empty space pans; dragging a part moves it. One gesture, two meanings,
    // decided by what is under the cursor.
    + "else{show(null);pan={x0:e.clientX,y0:e.clientY,vx:vb.x,vy:vb.y};"
    + "svg.classList.add('panning');}});"
    + "window.addEventListener('mousemove',function(e){"
    + "if(pan){const k=vb.w/svg.clientWidth;"
    + "vb.x=pan.vx-(e.clientX-pan.x0)*k;vb.y=pan.vy-(e.clientY-pan.y0)*k;apply();return;}"
    + "if(!drag)return;const p=pt(e);drag.dx=p.x-drag.x0;drag.dz=p.y-drag.z0;"
    + "if(Math.abs(drag.dx)+Math.abs(drag.dz)>1)drag.moved=true;"
    + "drag.g.setAttribute('transform','translate('+drag.dx+','+drag.dz+')');});"
    + "window.addEventListener('mouseup',function(e){"
    + "if(link){const t=e.target.closest&&e.target.closest('.part');"
    + "svg.classList.remove('linking');"
    // Only chambers and boxes can be joined; a solid is subtracted space, not a room.
    + "if(t&&t.dataset.key!==link.from&&t.dataset.kind!=='solid')"
    + "vscode.postMessage({type:'link',from:link.from,to:t.dataset.key});"
    + "link=null;return;}"
    + "if(pan){pan=null;svg.classList.remove('panning');report();return;}"
    + "if(!drag)return;"
    // A click to SELECT must never touch the file - only a real move writes.
    // SVG y grows down and world +Z is up, so the drag's dz is negated here -
    // the message carries WORLD deltas and the model never sees screen space.
    + "if(drag.moved)vscode.postMessage({type:'move',key:drag.key,dx:drag.dx,dz:-drag.dz});"
    + "drag.g.removeAttribute('transform');drag=null;});"
    // Zoom about the cursor, so the thing under the pointer stays under it.
    + "svg.addEventListener('wheel',function(e){e.preventDefault();"
    + "const p=pt(e);const k=e.deltaY>0?1.15:1/1.15;"
    + "vb.x=p.x-(p.x-vb.x)*k;vb.y=p.y-(p.y-vb.y)*k;vb.w*=k;vb.h*=k;apply();report();},"
    + "{passive:false});"
    // Double-click clears zoom and pan, the same gesture the game's radar uses.
    + "svg.addEventListener('dblclick',function(){vb={x:BASE.x,y:BASE.y,w:BASE.w,h:BASE.h};"
    + "apply();report();});"
    + "const fit=document.getElementById('fit');"
    + "if(fit)fit.addEventListener('click',function(){"
    + "vb={x:BASE.x,y:BASE.y,w:BASE.w,h:BASE.h};apply();report();});"
    // ---- the inspector: select a part, type a number, one line changes ----
    // Numbers matter here in a way dragging cannot serve: a radius of exactly 900, a
    // height of exactly 2200. Dragging is for arranging, typing is for meaning it.
    + "const insp=document.getElementById('insp');"
    + "const F={x:'fx',y:'fy',z:'fz',r:'fr',hx:'fhx',hy:'fhy',hz:'fhz'};"
    + "let sel=null;"
    + "function show(g){sel=g;if(!g){insp.classList.add('hidden');return;}"
    + "insp.classList.remove('hidden');"
    + "document.getElementById('iname').textContent=g.dataset.name||g.dataset.key;"
    + "document.getElementById('ikind').textContent=g.dataset.shape||g.dataset.kind;"
    + "for(const k in F){const el=document.getElementById(F[k]);"
    + "const v=g.dataset[k];el.value=(v===undefined?'':v);}"
    + "const box=g.dataset.kind==='box'||g.dataset.shape==='box';"
    + "document.getElementById('lr').classList.toggle('hidden',box);"
    + "['lhx','lhy','lhz'].forEach(function(id){"
    + "document.getElementById(id).classList.toggle('hidden',!box);});}"
    // Commit on change (blur or Enter), not on every keystroke - otherwise typing "1200"
    // would write 1, then 12, then 120, and each one is an undo step.
    + "for(const k in F){document.getElementById(F[k]).addEventListener('change',"
    + "function(){if(!sel)return;const v=Number(this.value);if(!isFinite(v))return;"
    + "const patch={};patch[k]=v;"
    + "vscode.postMessage({type:'field',key:sel.dataset.key,patch:patch});});}"
    // Delete removes the selected part; the button and the key do the same thing, because
    // a plan is a picture and not everyone reaches for a keyboard in one.
    + "function del(){if(sel)vscode.postMessage({type:'remove',key:sel.dataset.key});}"
    + "document.getElementById('del').addEventListener('click',del);"
    + "window.addEventListener('keydown',function(e){"
    + "if(e.target.tagName==='INPUT')return;"        // typing a number is not a delete
    + "if(e.key==='Delete'||e.key==='Backspace'){e.preventDefault();del();}});"
    // A new chamber lands at the middle of what you are looking at, which is the only
    // place the author has told us they care about.
    + "document.getElementById('add').addEventListener('click',function(){"
    + "vscode.postMessage({type:'add',x:Math.round(vb.x+vb.w/2),"
    + "z:Math.round(0-(vb.y+vb.h/2))});});"
    + "document.getElementById('prev').addEventListener('click',function(){"
    + "vscode.postMessage({type:'preview'});});"
    + "const lv=document.getElementById('live');"
    + "lv.addEventListener('click',function(){"
    + "const on=!lv.classList.contains('on');lv.classList.toggle('on',on);"
    + "vscode.postMessage({type:'live',on:on});});"
    // Ctrl-Z inside a webview goes to the WEBVIEW, which has no undo stack - it never
    // reaches the document our edits actually landed on. So the panel offers undo
    // explicitly. The keybinding is kept too, so the reflex still works.
    + "document.getElementById('undo').addEventListener('click',function(){"
    + "vscode.postMessage({type:'undo'});});"
    + "const b2=document.getElementById('m2d'),b3=document.getElementById('m3d');"
    + "if(b2)b2.addEventListener('click',function(){"
    + "vscode.postMessage({type:'mode',mode:'plan'});});"
    + "if(b3)b3.addEventListener('click',function(){"
    + "vscode.postMessage({type:'mode',mode:'3d'});});"
    + "window.addEventListener('keydown',function(e){"
    + "if(e.target.tagName==='INPUT')return;"
    + "if((e.ctrlKey||e.metaKey)&&e.key==='z'){e.preventDefault();"
    + "vscode.postMessage({type:'undo'});}});"
    + "const pick=document.getElementById('pick');"
    + "if(pick)pick.addEventListener('change',function(){"
    + "vscode.postMessage({type:'pick',index:Number(pick.value)});});";

  return '<!DOCTYPE html><html><head><meta charset="utf-8">'
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; '
    + 'style-src \'unsafe-inline\'; script-src \'nonce-' + nonce + '\';">'
    + '<style>' + style + '</style></head><body>'
    + '<header>' + picker + '<button id="fit">Fit</button>'
    + '<button id="m2d"' + (mode === '3d' ? '' : ' class="on"')
    + ' title="Top-down plan: drag to move a chamber, edit its numbers">Plan</button>'
    + '<button id="m3d"' + (mode === '3d' ? ' class="on"' : '')
    + ' title="Orbit the relic. Needs nothing running - a relic can sit 80k out or not '
    + 'exist until a quest spawns it, so booting the mission is no way to look at it">3D</button>'
    + (mode === '3d' ? '' : '<button id="add">Add chamber</button>')
    + (mode === '3d' ? '' : '<button id="del">Delete</button>')
    + '<button id="undo" title="Undo the last edit to the .amd file (CTRL-Z in a webview does not reach it)">Undo</button>'
    + '<button id="prev" title="Rebuild this relic in a running sbs debug session">Preview</button>'
    + '<button id="live"' + (live ? ' class="on"' : '')
    + ' title="Preview automatically after every edit, instead of pressing Preview">Live</button>'
    + '<span class="hint">' + (mode === '3d'
      ? 'drag to orbit &middot; SHIFT-drag to pan &middot; wheel to zoom '
        + '&middot; edit in the Plan view'
      : 'drag a chamber to move it &middot; drag the background to pan '
        + '&middot; wheel to zoom &middot; SHIFT-drag between chambers to connect '
        + '&middot; grid 1k, bold 10k')
    + '</span></header>' + warn
    + '<div id="insp" class="insp hidden">'
    + '<div class="ititle"><span id="iname"></span> <span id="ikind" class="ikind"></span></div>'
    + '<label>x <input id="fx" type="number" step="10"></label>'
    + '<label>y <input id="fy" type="number" step="10"></label>'
    + '<label>z <input id="fz" type="number" step="10"></label>'
    + '<label id="lr">r <input id="fr" type="number" step="10" min="1"></label>'
    + '<label id="lhx" class="hidden">hx <input id="fhx" type="number" step="10" min="1"></label>'
    + '<label id="lhy" class="hidden">hy <input id="fhy" type="number" step="10" min="1"></label>'
    + '<label id="lhz" class="hidden">hz <input id="fhz" type="number" step="10" min="1"></label>'
    + '<div class="ihint">y is height - the plan cannot show it</div></div>'
    + (mode === '3d'
      ? ('<div class="wrap"><svg id="scene3" viewBox="' + v3.x + ' ' + v3.y + ' '
         + v3.w + ' ' + v3.h + '" preserveAspectRatio="xMidYMid meet">'
         + '<g id="scene3g">' + V3.body(rel, cam3) + '</g></svg></div>'
         + '<script nonce="' + nonce + '">' + Orbit.script(rel, cam3, v3) + '</script>')
      : ('<div class="wrap"><svg id="plan" viewBox="' + vb.x + ' ' + vb.y + ' ' + vb.w
         + ' ' + vb.h + '" preserveAspectRatio="xMidYMid meet">' + grid + '<g>' + svg
         + '</g></svg></div>'
         + '<script nonce="' + nonce + '">' + script + '</script>'))
    + '</body></html>';
}

module.exports = { render, extent, stackRows, gridLines, bounds, sy, span,
                   GRID_MINOR, GRID_MAJOR, RENDER_DISTANCE };
