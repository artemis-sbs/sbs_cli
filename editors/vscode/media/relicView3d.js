// The relic as a 3D shape, drawn by the editor itself.
//
// WHY NOT A RUNNING SESSION. Booting the mission does not reliably show you the relic: it
// may sit 80,000 units from the spawn, or not exist at all until a quest spawns it. Flying
// there to check a chamber radius is not a preview loop. The plan view answers "is the
// layout right"; this answers "what does it look like", and both have to work with nothing
// running.
//
// SVG rather than WebGL, orthographic rather than perspective. Under an orthographic
// camera a sphere is exactly a circle, a capsule is exactly a thick round-capped line, and
// a box is eight projected corners - so the whole scene is painter-algorithm SVG with no
// library, no shader, and nothing external for the CSP to block. It is also pure enough to
// unit test, which a canvas is not.
//
// AXES. World +Y is up (a chamber's second number is altitude); the plan view draws XZ
// with +Z up the screen. Looking straight down here reproduces the plan exactly, which is
// what makes the two views legible as the same relic.
'use strict';

/** Rotate world (x,y,z) into camera space and project. `cam` is {yaw, pitch} in radians.
 *  Returns {x, y, depth} - depth grows AWAY from the eye, SVG y grows downward. */
function project(p, cam) {
  const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
  const xr = (p.x || 0) * cy + (p.z || 0) * sy;
  const zr = -(p.x || 0) * sy + (p.z || 0) * cy;
  const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
  const up = (p.y || 0) * cp + zr * sp;
  const depth = -(p.y || 0) * sp + zr * cp;
  return { x: xr, y: -up, depth };
}

/** Screen point back to a world point on the horizontal plane at height `y`.
 *
 *  The inverse of `project` with one degree of freedom pinned - which is the only way to
 *  invert it at all, since a screen point is a whole line in the world. Pinning HEIGHT is
 *  the useful choice: it is what "put a new chamber where I am looking" means, and it
 *  keeps the answer on the same floor as whatever the view is pivoting around.
 *
 *  Looking along the horizon (pitch 0) the horizontal plane is edge-on and the answer is
 *  a whole line, so it falls back to the plane through the origin instead of returning a
 *  number it cannot justify.
 */
function unproject(sx, sy, cam, y) {
  const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
  const up = -sy;
  const zr = Math.abs(sp) < 1e-6 ? 0 : (up - (y || 0) * cp) / sp;
  const cy = Math.cos(cam.yaw), sy2 = Math.sin(cam.yaw);
  // The inverse of the yaw rotation in `project`.
  return { x: sx * cy - zr * sy2, y: y || 0, z: sx * sy2 + zr * cy };
}

/** Straight down - the plan view's own angle, which is what makes the two agree. */
function topDown() { return { yaw: 0, pitch: Math.PI / 2 }; }

/** Three-quarter: enough yaw to separate chambers, enough pitch to read height. */
function defaultCamera() { return { yaw: 0.6, pitch: 0.5 }; }

function esc(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** The 12 edges of a box, as index pairs into boxCorners' output. */
const BOX_EDGES = [[0,1],[0,2],[0,4],[1,3],[1,5],[2,3],[2,6],[3,7],[4,5],[4,6],[5,7],[6,7]];

/** The eight projected corners of an axis-aligned box. */
function boxCorners(b, cam) {
  const out = [];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        out.push(project({ x: b.x + sx * b.hx, y: b.y + sy * b.hy, z: b.z + sz * b.hz }, cam));
      }
    }
  }
  return out;
}

/** Every drawable, projected and sorted far-to-near.
 *
 *  Exported because the ORDER is the only thing between this and a far chamber drawn on
 *  top of the wall in front of it. The sort is stable, so equal depths keep author order
 *  and a redraw at the same angle never flickers between two arrangements. */
function scene(rel, cam) {
  const items = [];
  const by = new Map([].concat(rel.chambers || [], rel.boxes || []).map((p) => [p.key, p]));

  for (const p of (rel.passages || [])) {
    const a = by.get(p.from), b = by.get(p.to);
    if (!a || !b) { continue; }        // dangling: lint reports it, the view omits it
    const pa = project(a, cam), pb = project(b, cam);
    const far = span(a, b) > RENDER_DISTANCE;
    items.push({ kind: 'passage', a: pa, b: pb, r: p.radius == null ? 200 : p.radius,
                 depth: (pa.depth + pb.depth) / 2, far, len: Math.round(span(a, b)),
                 label: p.from + ' - ' + p.to });
  }
  for (const c of (rel.chambers || [])) {
    const q = project(c, cam);
    items.push({ kind: 'chamber', at: q, r: c.r, depth: q.depth,
                 key: c.key, label: c.name || c.key, y: c.y });
  }
  for (const b of (rel.boxes || [])) {
    const q = project(b, cam);
    items.push({ kind: 'box', at: q, depth: q.depth, key: b.key,
                 hx: b.hx, hy: b.hy, hz: b.hz,
                 label: b.name || b.key, corners: boxCorners(b, cam) });
  }
  for (const s of (rel.solids || [])) {
    const q = project(s, cam);
    // -1 breaks ties toward the front: a solid sits INSIDE a chamber, so at equal depth
    // it is the thing you are meant to see.
    items.push({ kind: 'solid', at: q, depth: q.depth - 1, r: s.r || 0, key: s.key,
                 label: s.name || s.kind || 'solid' });
  }
  return items.sort((m, n) => n.depth - m.depth);
}

/** How far the scene reaches on screen, so the caller can frame it. */
function extent(items) {
  const min = { x: Infinity, y: Infinity }, max = { x: -Infinity, y: -Infinity };
  const eat = (x, y, pad) => {
    min.x = Math.min(min.x, x - pad); max.x = Math.max(max.x, x + pad);
    min.y = Math.min(min.y, y - pad); max.y = Math.max(max.y, y + pad);
  };
  for (const it of items) {
    if (it.kind === 'chamber' || it.kind === 'solid') { eat(it.at.x, it.at.y, it.r || 0); }
    else if (it.kind === 'passage') { eat(it.a.x, it.a.y, it.r); eat(it.b.x, it.b.y, it.r); }
    else if (it.kind === 'box') { for (const c of it.corners) { eat(c.x, c.y, 0); } }
  }
  if (!isFinite(min.x)) { return { x: -1000, y: -1000, w: 2000, h: 2000 }; }
  return { x: min.x, y: min.y, w: Math.max(1, max.x - min.x), h: Math.max(1, max.y - min.y) };
}

// Grid spacing, matching the game's own 2D view: a minor line every 1000 units and a
// major every 10000, so a chamber radius can be counted off the picture rather than read
// off a label.
const GRID_MINOR = 1000;
const GRID_MAJOR = 10000;

// The engine's `render-distance-objects`. A corridor longer than this goes dark at the far
// end - stand in one chamber and the other simply is not drawn - which reads as a
// rendering bug rather than a layout one. Deliberately NOT a lint rule: it is a setting,
// not a correctness claim, so the feedback belongs where the dragging happens.
const RENDER_DISTANCE = 5000;

/** 3D distance between two parts. */
function span(a, b) {
  const dx = a.x - b.x, dy = (a.y || 0) - (b.y || 0), dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** The ground plane as projected grid lines.
 *
 *  Drawn in the WORLD at y=0 rather than across the screen, so it tilts with the view and
 *  reads as a floor the relic stands on - which is also what tells you, at a glance, which
 *  way is up. Looking straight down it becomes the plan view's own grid again.
 *
 *  Thinned out the same way the plan's is: past a few hundred lines a grid stops being a
 *  ruler and becomes a grey wash.
 */
function groundGrid(rel, cam, span) {
  const lines = [];
  const reach = Math.max(2000, span || 12000);
  const step = (reach / GRID_MINOR) > 240 ? GRID_MAJOR : GRID_MINOR;
  const n = Math.ceil(reach / step);
  const end = n * step;
  for (let i = -n; i <= n; i++) {
    const v = i * step;
    const major = (v % GRID_MAJOR) === 0;
    for (const along of [0, 1]) {
      const a = along ? { x: -end, y: 0, z: v } : { x: v, y: 0, z: -end };
      const b = along ? { x: end, y: 0, z: v } : { x: v, y: 0, z: end };
      const pa = project(a, cam), pb = project(b, cam);
      lines.push({ a: pa, b: pb, major });
    }
  }
  return lines;
}

/** Depth shading: nearer is brighter, so a shell of same-coloured circles still reads as
 *  a solid whose far side is behind its near side. */
function shade(depth, lo, hi) {
  const t = hi > lo ? (depth - lo) / (hi - lo) : 0.5;   // 0 near .. 1 far
  const k = Math.max(0, Math.min(1, 1 - t));
  return 0.3 + 0.55 * k;
}

/** The ground grid as SVG. `w` is the current view width, used to keep the line weight
 *  constant on screen however far you zoom. */
function gridSvg(rel, cam, span, w) {
  const sw = (w || 12000) / 900;
  let out = '<g id="grid3" pointer-events="none">';
  for (const l of groundGrid(rel, cam, span)) {
    out += '<line x1="' + l.a.x.toFixed(1) + '" y1="' + l.a.y.toFixed(1)
      + '" x2="' + l.b.x.toFixed(1) + '" y2="' + l.b.y.toFixed(1)
      + '" stroke="var(--vscode-panel-border,#8883)" stroke-opacity="'
      + (l.major ? 0.55 : 0.22) + '" stroke-width="' + (sw * (l.major ? 1.8 : 1)).toFixed(1)
      + '"/>';
  }
  return out + '</g>';
}

/** Label placement in SCREEN space, fanned so names do not sit on top of each other.
 *
 *  The plan view fans by world row; here it has to be by projected position, because two
 *  chambers far apart in the world can land on the same pixel from one angle and not from
 *  another. Same idea, different space: sort down the screen, and push any label that
 *  would land within `gap` of the previous one further down.
 */
function labelRows(items, gap) {
  const g = gap || 1;
  const named = items.filter((it) => it.kind === 'chamber' || it.kind === 'box')
    .map((it) => ({ key: it.key, label: it.label, x: it.at.x, y: it.at.y, r: it.r || 0 }))
    .sort((a, b) => a.y - b.y);
  let last = -Infinity;
  for (const n of named) {
    const want = n.y - (n.r ? n.r * 0.35 : 0);
    n.ly = want < last + g ? last + g : want;
    last = n.ly;
  }
  return named;
}

/** Those labels as SVG, with a leader line when one had to be pushed off its part. */
function labelSvg(items, size) {
  const s = size || 300;
  let out = '<g id="lab3" pointer-events="none">';
  for (const n of labelRows(items, s * 1.15)) {
    if (Math.abs(n.ly - n.y) > s * 0.4) {
      out += '<line x1="' + n.x.toFixed(1) + '" y1="' + n.y.toFixed(1) + '" x2="'
        + n.x.toFixed(1) + '" y2="' + n.ly.toFixed(1)
        + '" stroke="var(--vscode-descriptionForeground,#888)" stroke-opacity="0.5"'
        + ' stroke-width="' + (s * 0.05) + '"/>';
    }
    out += '<text x="' + n.x.toFixed(1) + '" y="' + n.ly.toFixed(1) + '" text-anchor="middle"'
      + ' font-size="' + s + '" fill="var(--vscode-foreground,#ddd)"'
      + ' font-family="var(--vscode-font-family)">' + esc(n.label) + '</text>';
  }
  return out + '</g>';
}

/** The scene as an SVG body (no wrapper) - the caller owns the viewBox. */
function body(rel, cam) {
  const items = scene(rel, cam);
  let lo = Infinity, hi = -Infinity;
  for (const it of items) { lo = Math.min(lo, it.depth); hi = Math.max(hi, it.depth); }
  let out = '';
  for (const it of items) {
    const a = shade(it.depth, lo, hi).toFixed(3);
    if (it.kind === 'passage') {
      out += '<line x1="' + it.a.x.toFixed(1) + '" y1="' + it.a.y.toFixed(1)
        + '" x2="' + it.b.x.toFixed(1) + '" y2="' + it.b.y.toFixed(1)
        + '" stroke="' + (it.far ? '#e0af68' : '#7aa2f7') + '" stroke-width="' + (it.r * 2)
        + '" stroke-opacity="' + (Number(a) * 0.5).toFixed(3)
        + '" stroke-linecap="round"' + (it.far ? ' stroke-dasharray="600 400"' : '')
        + '><title>' + esc(it.label) + ': ' + it.len + 'u'
        + (it.far ? ' - past the ' + RENDER_DISTANCE + 'u render distance, so the far end '
                  + 'stops drawing' : '') + '</title></line>';
    } else if (it.kind === 'chamber') {
      out += '<circle class="p3" cx="' + it.at.x.toFixed(1) + '" cy="' + it.at.y.toFixed(1)
        + '" r="' + it.r + '" fill="#7aa2f7" fill-opacity="' + (Number(a) * 0.4).toFixed(3)
        + '" stroke="#9ec3ff" stroke-opacity="' + a + '" stroke-width="6"'
        + ' data-key="' + esc(it.key) + '"><title>' + esc(it.label) + ' r' + it.r
        + (it.y ? ' y' + it.y : '') + '</title></circle>';
    } else if (it.kind === 'box') {
      // THE WHOLE BOX IS THE TARGET, not a dot at its middle. The hit area used to be a
      // 60-unit circle with fill="none" - an unfilled shape is not hit-testable in its
      // interior, so a box could not be selected at all, and its move and size gizmos
      // were unreachable rather than missing.
      //
      // Wrapping the edges in the group is what does it: a stroked line IS hit-testable
      // along its stroke, so clicking any edge selects the box.
      out += '<g class="p3" data-key="' + esc(it.key) + '">'
        + '<title>' + esc(it.label) + '</title>';
      for (const e of BOX_EDGES) {
        const p = it.corners[e[0]], q = it.corners[e[1]];
        out += '<line x1="' + p.x.toFixed(1) + '" y1="' + p.y.toFixed(1) + '"'
          + ' x2="' + q.x.toFixed(1) + '" y2="' + q.y.toFixed(1) + '"'
          + ' stroke="#9ece6a" stroke-opacity="' + a + '" stroke-width="8"/>';
      }
      // A filled centre marker as well, sized to the box: the edges can be awkward to
      // hit edge-on, and a transparent fill still takes a click.
      const rr = Math.max(60, Math.min(it.hx, it.hy, it.hz) * 0.4);
      out += '<circle cx="' + it.at.x.toFixed(1) + '" cy="' + it.at.y.toFixed(1) + '"'
        + ' r="' + rr.toFixed(0) + '" fill="#9ece6a" fill-opacity="'
        + (Number(a) * 0.25).toFixed(3) + '"/>';
      out += '</g>';
    } else if (it.kind === 'solid') {
      // A subtracted mass, drawn as a HOLE - dashed and unfilled. Filling it would read
      // as another room, which is the exact opposite of what it is.
      out += '<circle cx="' + it.at.x.toFixed(1) + '" cy="' + it.at.y.toFixed(1)
        + '" r="' + (it.r || 100) + '" fill="none" stroke="#f7768e" stroke-opacity="' + a
        + '" stroke-width="8" stroke-dasharray="40 30" class="p3" data-key="' + esc(it.key)
        + '"><title>'
        + esc(it.label) + ' (subtracted)</title></circle>';
    }
  }
  return out;
}

/** Shift a viewBox so a pivot that has moved on screen appears not to have.
 *
 *  The projection turns about the world ORIGIN, so orbiting swings whatever you were
 *  looking at out of frame - worst exactly when you have zoomed in on it. Rather than
 *  complicate the camera with a pivot, project the pivot before and after and slide the
 *  viewBox by the difference: the pivot lands back on the same pixel and the view reads as
 *  turning around it.
 *
 *  Exact, not approximate. The pivot's offset within the box is
 *  `after - (vb + (after - before))` = `before - vb`, which is what it was.
 */
function holdPivot(vb, before, after) {
  return { x: vb.x + (after.x - before.x), y: vb.y + (after.y - before.y),
           w: vb.w, h: vb.h };
}

/** The SAME functions, as source, for the webview to run.
 *
 *  Orbiting has to redraw on every mouse move, so the projection must live in the page -
 *  a round trip to the extension per frame would be visible. Shipping the functions'
 *  own source rather than a hand-written copy is what stops the two drifting: the code
 *  the tests exercise IS the code the page runs.
 */
function clientBundle() {
  // Everything `body` reaches for, transitively. A function left out of this list is
  // not a missing feature in the page - it is a ReferenceError that blanks the view,
  // which is how `span` and RENDER_DISTANCE were caught the moment scene() started
  // using them.
  return 'const RENDER_DISTANCE = ' + RENDER_DISTANCE + ';\n'
    + 'const GRID_MINOR = ' + GRID_MINOR + ';\n'
    + 'const GRID_MAJOR = ' + GRID_MAJOR + ';\n'
    + [esc, project, unproject, span, boxCorners, scene, extent, shade, body, holdPivot,
       groundGrid, gridSvg, labelRows, labelSvg]
    .map(function (f) { return f.toString(); }).join('\n')
    + '\nconst BOX_EDGES = ' + JSON.stringify(BOX_EDGES) + ';\n';
}

module.exports = { project, unproject, scene, body, extent, boxCorners, shade, clientBundle,
                   span, RENDER_DISTANCE,
                   groundGrid, gridSvg, labelRows, labelSvg, GRID_MINOR, GRID_MAJOR,
                   holdPivot,
                   topDown, defaultCamera, BOX_EDGES };
