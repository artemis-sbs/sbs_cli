// The move gizmo for the 3D view: three axis handles on the selected part.
//
// WHY A GIZMO AND NOT FREE DRAGGING. A screen is two-dimensional and a relic is not, so a
// bare drag in a 3D view is ambiguous - the same mouse movement could mean any of a plane
// of world positions. Constraining each drag to ONE axis makes it a question with an
// answer, and it is the same reason every 3D tool does it.
//
// THE MATH, which is short because the camera is orthographic. Project the part's centre
// and the point one axis-length along the axis; the difference is that axis as a screen
// direction. A mouse movement projected onto that direction, divided by its length, is
// how far along the axis you dragged. No inverse matrix, no ray casting, no perspective
// divide - and it is exact rather than an approximation.
//
//     d = project(c + axis*L) - project(c)      the axis, on screen
//     t = (mouse . d) / (d . d)                 how far along it you went
//     world delta = axis * L * t
//
// AN AXIS POINTING AT THE CAMERA CANNOT BE DRAGGED. Its screen direction collapses to a
// point, so `d . d` approaches zero and t explodes: a pixel of mouse movement becomes
// thousands of units. Such a handle is faded and refuses the drag rather than obeying it
// wildly, which is the failure people report as "it jumped".
'use strict';

const AXES = [
  { key: 'x', v: { x: 1, y: 0, z: 0 }, color: '#f7768e' },
  { key: 'y', v: { x: 0, y: 1, z: 0 }, color: '#9ece6a' },
  { key: 'z', v: { x: 0, y: 0, z: 1 }, color: '#7aa2f7' },
];

// Below this screen length (in SVG user units, relative to handle length) an axis is
// treated as edge-on and undraggable.
const EDGE_ON = 0.12;

/**
 * Where each axis handle lands on screen, and whether it can be dragged.
 * Pure, so the awkward case - an axis pointing at the eye - is testable.
 *
 * @param {object} c        the part's world centre {x,y,z}
 * @param {object} cam      {yaw, pitch}
 * @param {number} L        handle length in WORLD units
 * @param {function} project  the projector (passed in so the page and the tests share one)
 */
function handles(c, cam, L, project) {
  const o = project(c, cam);
  return AXES.map((a) => {
    const tip = project({ x: c.x + a.v.x * L, y: c.y + a.v.y * L, z: c.z + a.v.z * L }, cam);
    const dx = tip.x - o.x, dy = tip.y - o.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    return {
      axis: a.key, color: a.color, o, tip, dx, dy, len,
      // Length is compared against the handle's own world length, so the test does not
      // change meaning when the view is zoomed.
      draggable: len > L * EDGE_ON,
    };
  });
}

/** How far along `h`'s axis a mouse movement of (mx, my) SVG units reaches. */
function along(h, mx, my) {
  const dd = h.dx * h.dx + h.dy * h.dy;
  if (dd <= 0) { return 0; }
  return (mx * h.dx + my * h.dy) / dd;
}

/** The gizmo as SVG. `L` is in world units; the caller scales it to the current zoom so
 *  the handles stay a constant size on screen however far you zoom in. */
function gizmoSvg(c, cam, L, project) {
  let out = '<g id="giz" pointer-events="all">';
  for (const h of handles(c, cam, L, project)) {
    const o = h.draggable ? 1 : 0.25;
    out += '<line class="gz" data-axis="' + h.axis + '"'
      + ' x1="' + h.o.x.toFixed(1) + '" y1="' + h.o.y.toFixed(1) + '"'
      + ' x2="' + h.tip.x.toFixed(1) + '" y2="' + h.tip.y.toFixed(1) + '"'
      + ' stroke="' + h.color + '" stroke-opacity="' + o + '" stroke-width="' + (L * 0.06)
      + '" stroke-linecap="round"><title>' + h.axis
      + (h.draggable ? '' : ' (edge-on - orbit to reach it)') + '</title></line>';
    out += '<circle class="gz" data-axis="' + h.axis + '"'
      + ' cx="' + h.tip.x.toFixed(1) + '" cy="' + h.tip.y.toFixed(1) + '"'
      + ' r="' + (L * 0.12) + '" fill="' + h.color + '" fill-opacity="' + o + '"/>';
  }
  return out + '</g>';
}

/** The size handles for a part, or [] if it has no size to drag.
 *
 *  A CHAMBER or a SPHERE SOLID has one number, a radius, and under an orthographic camera
 *  it projects to a circle of exactly that radius - so the handle can sit on the rim and
 *  the drag is simply "how far is the cursor from the centre". No axis, no projection
 *  factor, and true from every angle.
 *
 *  A BOX has three, and they are HALF-extents, so each handle rides its own axis and the
 *  drag is the same axis projection the move gizmo uses. They sit at the face centres,
 *  which is where the number actually reaches.
 */
function sizeHandles(part, cam, project) {
  const o = project(part, cam);
  if (part.hx !== undefined) {
    // SIX handles, one per FACE - and dragging one moves THAT WALL, leaving the opposite
    // where it is. A single handle per axis can only grow the box about its centre, so
    // dragging the right wall moves the left one too, which is the classic complaint
    // about box editors and is wrong for the job here: boxes are laid out by dragging a
    // wall until it meets its neighbour.
    //
    // It still writes one line, because `Box:` carries the centre and the half-extents
    // together - a one-sided resize is just both of them moving by half the drag.
    const out = [];
    const axes = [
      { f: 'hx', v: { x: 1, y: 0, z: 0 }, n: part.hx, color: '#f7768e' },
      { f: 'hy', v: { x: 0, y: 1, z: 0 }, n: part.hy, color: '#9ece6a' },
      { f: 'hz', v: { x: 0, y: 0, z: 1 }, n: part.hz, color: '#7aa2f7' },
    ];
    for (const a of axes) {
      for (const sign of [1, -1]) {
        const tip = project({ x: part.x + a.v.x * a.n * sign,
                              y: part.y + a.v.y * a.n * sign,
                              z: part.z + a.v.z * a.n * sign }, cam);
        const dx = tip.x - o.x, dy = tip.y - o.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        out.push({ field: a.f, axis: a.f.slice(1), sign, color: a.color, o, tip,
                   dx, dy, len, value: a.n,
                   draggable: len > Math.abs(a.n) * EDGE_ON });
      }
    }
    return out;
  }
  if (part.r === undefined || part.r === null) { return []; }
  // A sphere has no faces, so its one number stays symmetric. On the rim, to the
  // screen-right: which point of the rim does not matter - the drag measures distance
  // from the centre - so pick the one that never hides behind a move handle.
  return [{ field: 'r', axis: 'r', sign: 1, color: '#e0af68', o,
            tip: { x: o.x + part.r, y: o.y },
            dx: part.r, dy: 0, len: part.r, value: part.r, draggable: true }];
}

/** The size gizmo as SVG. `s` scales the grab dots with the zoom. */
function sizeSvg(part, cam, project, s) {
  const hs = sizeHandles(part, cam, project);
  if (!hs.length) { return ''; }
  let out = '<g id="sz" pointer-events="all">';
  for (const h of hs) {
    const o = h.draggable ? 1 : 0.25;
    out += '<rect class="sz" data-field="' + h.field + '" data-sign="' + h.sign + '"'
      + ' x="' + (h.tip.x - s * 0.11).toFixed(1) + '" y="' + (h.tip.y - s * 0.11).toFixed(1) + '"'
      + ' width="' + (s * 0.22) + '" height="' + (s * 0.22) + '"'
      + ' fill="' + h.color + '" fill-opacity="' + o + '" rx="' + (s * 0.04) + '">'
      + '<title>' + (h.sign > 0 ? '+' : '-') + h.axis + ' wall, ' + h.field + ' ' + Math.round(h.value)
      + (h.draggable ? '' : ' (edge-on - orbit to reach it)') + '</title></rect>';
  }
  return out + '</g>';
}

/** The same functions, as source, for the webview - see relicView3d.clientBundle for
 *  why a copy is not acceptable here. */
function clientBundle() {
  return 'const AXES = ' + JSON.stringify(AXES) + ';\n'
    + 'const EDGE_ON = ' + EDGE_ON + ';\n'
    + [handles, along, gizmoSvg, sizeHandles, sizeSvg].map(function (f) { return f.toString(); }).join('\n')
    + '\n';
}

module.exports = { handles, along, gizmoSvg, sizeHandles, sizeSvg,
                   clientBundle, AXES, EDGE_ON };
