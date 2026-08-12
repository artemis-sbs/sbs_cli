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
const Nav = require('./relicNav.js');

// The grid spacing and the render distance live in relicView3d, with the geometry that
// uses them. Re-exported here only because the tests and the panel already ask this
// module for them - two definitions of 5000 is one more than the number can survive.
const GRID_MINOR = V3.GRID_MINOR;
const GRID_MAJOR = V3.GRID_MAJOR;
const RENDER_DISTANCE = V3.RENDER_DISTANCE;
const span = V3.span;

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Render the plan.
 *
 * `view` is an optional {x, y, w, h} viewBox - the webview reports its own after a zoom
 * or pan so the panel can be redrawn without throwing away where you were looking. A
 * redraw happens on every keystroke in the document, so losing it would make the plan
 * unusable while editing.
 */
function render(relics, nonce, index, view, live, cam, sel3) {
  const rel = relics[index];
  if (!rel) {
    return '<!DOCTYPE html><html><body style="font-family:var(--vscode-font-family);'
      + 'color:var(--vscode-foreground);padding:12px"><p>No relic in this file.</p>'
      + '<p style="opacity:.7">A relic is a record in a <code>Relics</code> section '
      + 'carrying a <code>Loc:</code>; its chambers are records carrying '
      + '<code>Relic:</code>.</p></body></html>';
  }
  // Framing for the ONE view. `view` is what the page last reported, so a redraw - which
  // fires on every keystroke in the document - puts you back where you were looking.
  // The camera and its framing.
  const cam3 = cam || V3.defaultCamera();
  const e3 = V3.extent(V3.scene(rel, cam3));
  const pad3 = Math.max(e3.w, e3.h) * 0.08;
  const v3 = (view && isFinite(view.w) && view.w > 0)
    ? view
    : { x: e3.x - pad3, y: e3.y - pad3, w: e3.w + pad3 * 2, h: e3.h + pad3 * 2 };

  const picker = relics.length > 1
    ? '<select id="pick">' + relics.map((r, i) => '<option value="' + i + '"'
        + (i === index ? ' selected' : '') + '>' + esc(r.name || r.key) + '</option>')
        .join('') + '</select>'
    : '<b>' + esc(rel.name || rel.key) + '</b>';

  // The passages the engine will not draw the far end of. Computed from the RELIC rather
  // than from the view, because it is a fact about the layout - the picture only reports
  // it. Not a lint rule: `sbs lint` deliberately stays out of size judgements and the
  // number is a SETTING, not a correctness claim, so the feedback belongs where the
  // author is dragging.
  const byKey = new Map([].concat(rel.chambers, rel.boxes).map((p) => [p.key, p]));
  const tooFar = [];
  for (const p of rel.passages) {
    const a = byKey.get(p.from), b = byKey.get(p.to);
    if (!a || !b) { continue; }
    const d = V3.span(a, b);
    if (d > V3.RENDER_DISTANCE) {
      tooFar.push(p.from + ' - ' + p.to + ' (' + Math.round(d) + 'u)');
    }
  }
  const warn = (rel.orphans.length
    ? '<div class="warn">' + rel.orphans.length
      + ' part(s) name a relic that does not exist &mdash; they are not built.</div>' : '')
    + (tooFar.length
    ? '<div class="warn">' + tooFar.length + ' passage(s) longer than the '
      + V3.RENDER_DISTANCE + 'u render distance &mdash; the far end stops drawing: '
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
    + '.p3{cursor:pointer}.sel3{stroke:#e0af68!important;stroke-width:14}'
    + '.gz{cursor:move}.sz{cursor:nwse-resize}'
    + '.wrap{position:relative}'
    + '.ctx{position:absolute;z-index:6;min-width:150px;padding:4px 0;'
    + 'background:var(--vscode-menu-background,#252526);'
    + 'color:var(--vscode-menu-foreground,#ccc);'
    + 'border:1px solid var(--vscode-menu-border,#454545);border-radius:5px;'
    + 'box-shadow:0 4px 16px #0008;font-size:12px}'
    + '.ctx div{padding:4px 12px;cursor:pointer;white-space:nowrap}'
    + '.ctx div:hover{background:var(--vscode-menu-selectionBackground,#04395e);'
    + 'color:var(--vscode-menu-selectionForeground,#fff)}'
    + '.ctx hr{border:0;border-top:1px solid var(--vscode-menu-border,#454545);margin:4px 0}'
    + '#navg{position:absolute;top:8px;right:8px;width:78px;height:78px;'
    + 'opacity:.9;z-index:4}'
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

  return '<!DOCTYPE html><html><head><meta charset="utf-8">'
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; '
    + 'style-src \'unsafe-inline\'; script-src \'nonce-' + nonce + '\';">'
    + '<style>' + style + '</style></head><body>'
    + '<header>' + picker + '<button id="fit">Fit</button>'
    + '<button id="add">Add chamber</button>'
    + '<button id="del">Delete</button>'
    // Named for what they SHOW, with the axis spelled out - Cosmos is Y-up and
    // Blender is Z-up, so anyone arriving from there will otherwise reach for
    // the wrong one.
    + '<button class="vw" data-view="top" title="Look down the Y axis - the plan view">Top</button>'
    + '<button class="vw" data-view="front" title="Look down the Z axis">Front</button>'
    + '<button class="vw" data-view="right" title="Look down the X axis">Right</button>'
    + '<button id="undo" title="Undo the last edit to the .amd file (CTRL-Z in a webview does not reach it)">Undo</button>'
    + '<button id="prev" title="Rebuild this relic in a running sbs debug session">Preview</button>'
    + '<button id="live"' + (live ? ' class="on"' : '')
    + ' title="Preview automatically after every edit, instead of pressing Preview">Live</button>'
    + '<span class="hint">click to select &middot; drag a handle to move or size '
    + '&middot; SHIFT-drag between parts to connect &middot; right-click for more '
    + '&middot; MIDDLE-drag to orbit &middot; SHIFT-middle to pan &middot; wheel to zoom'
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
    + '<div class="ihint">drag a handle, or type an exact number here</div></div>'
    + '<div class="wrap"><svg id="scene3" viewBox="' + v3.x + ' ' + v3.y + ' '
    + v3.w + ' ' + v3.h + '" preserveAspectRatio="xMidYMid meet">'
    + V3.gridSvg(rel, cam3, Math.max(v3.w, v3.h), v3.w)
    + '<g id="scene3g">' + V3.body(rel, cam3) + '</g>'
    + '<g id="lab3g">' + V3.labelSvg(V3.scene(rel, cam3), Math.max(v3.w, v3.h) / 42) + '</g>'
    + '</svg>'
    + '<div id="ctx" class="ctx hidden"></div>'
    + '<svg id="navg" viewBox="0 0 100 100">' + Nav.navSvg(cam3, V3.project, 100)
    + '</svg></div>'
    + '<script nonce="' + nonce + '">' + Orbit.script(rel, cam3, v3, sel3) + '</script>'
    + '</body></html>';
}

module.exports = { render, span, GRID_MINOR, GRID_MAJOR, RENDER_DISTANCE };
