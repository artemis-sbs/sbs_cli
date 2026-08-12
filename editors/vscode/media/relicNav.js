// The navigation gizmo: the little axis widget in the corner that orients the view.
//
// Blender's, deliberately - its manual describes it as "Display the axis as an interactive
// gizmo. Click sets the viewport to display along this axis and dragging orbits the view",
// and copying a control people already know beats inventing a worse one. Filled balls are
// the positive axes and carry a letter; hollow ones are the negatives.
//
// IT LIVES IN SCREEN SPACE, not the scene. The main SVG's viewBox is in world units and
// moves with pan and zoom, so a widget drawn there would slide off the corner and change
// size. This is its own small overlay with its own coordinates, which is also why its
// radius is in pixels rather than metres.
'use strict';

// THE AXES ARE NOT BLENDER'S. The control is borrowed; the convention is not.
//
//     Blender   +Z up, +Y into the screen, right-handed Z-up
//     Cosmos    +Y up (a chamber's second number is ALTITUDE), X and Z are the ground
//
// So the ball that means "look down from above" is the Y ball here and the Z ball there.
// Anyone reading this widget as Blender's will reach for the wrong one, which is why the
// mapping is written out rather than left to be inferred:
//
//     click Y  ->  top     looking down the Y axis   (X across, Z into the screen)
//     click Z  ->  front   looking down the Z axis   (X across, Y up)
//     click X  ->  right   looking down the X axis   (Z across, Y up)
//
// `top` reproduces the plan view exactly - same axes, same +Z up the screen - which is
// what makes Plan and 3D the same editor at two angles rather than two editors.
const VIEWS = {
  top:    { yaw: 0,             pitch: Math.PI / 2 },
  bottom: { yaw: 0,             pitch: -Math.PI / 2 },
  front:  { yaw: 0,             pitch: 0 },
  back:   { yaw: Math.PI,       pitch: 0 },
  right:  { yaw: Math.PI / 2,   pitch: 0 },
  left:   { yaw: -Math.PI / 2,  pitch: 0 },
};

// Which ball is which axis end, and what clicking it means.
const BALLS = [
  { axis: 'x', sign: 1,  label: 'X', view: 'right',  color: '#f7768e', v: { x: 1, y: 0, z: 0 } },
  { axis: 'x', sign: -1, label: '',  view: 'left',   color: '#f7768e', v: { x: -1, y: 0, z: 0 } },
  { axis: 'y', sign: 1,  label: 'Y', view: 'top',    color: '#9ece6a', v: { x: 0, y: 1, z: 0 } },
  { axis: 'y', sign: -1, label: '',  view: 'bottom', color: '#9ece6a', v: { x: 0, y: -1, z: 0 } },
  { axis: 'z', sign: 1,  label: 'Z', view: 'front',  color: '#7aa2f7', v: { x: 0, y: 0, z: 1 } },
  { axis: 'z', sign: -1, label: '',  view: 'back',   color: '#7aa2f7', v: { x: 0, y: 0, z: -1 } },
];

/** Where each ball sits in the widget, sorted BACK TO FRONT.
 *
 *  The sort is the whole reason this reads as three-dimensional: without it a ball behind
 *  the origin paints over one in front and the widget looks inside-out. */
function balls(cam, project, size) {
  const R = size * 0.34;
  return BALLS.map((b) => {
    const p = project(b.v, cam);
    return {
      view: b.view, label: b.label, color: b.color, sign: b.sign,
      x: size / 2 + p.x * R, y: size / 2 + p.y * R, depth: p.depth,
    };
  }).sort((m, n) => n.depth - m.depth);
}

/** The widget as SVG, in its own `size` x `size` box. */
function navSvg(cam, project, size) {
  const s = size || 100;
  const c = s / 2;
  const bs = balls(cam, project, s);
  let out = '';
  // Spokes first, so a ball always sits on top of its own line.
  for (const b of bs) {
    if (b.sign > 0) {
      out += '<line x1="' + c + '" y1="' + c + '" x2="' + b.x.toFixed(1) + '" y2="'
        + b.y.toFixed(1) + '" stroke="' + b.color + '" stroke-opacity="0.8"'
        + ' stroke-width="' + (s * 0.035) + '" stroke-linecap="round"/>';
    }
  }
  for (const b of bs) {
    const r = s * 0.12;
    out += '<g class="nav" data-view="' + b.view + '" style="cursor:pointer">';
    out += '<circle cx="' + b.x.toFixed(1) + '" cy="' + b.y.toFixed(1) + '" r="' + r + '"'
      + (b.sign > 0
        ? ' fill="' + b.color + '"'
        : ' fill="var(--vscode-editor-background,#1e1e1e)" stroke="' + b.color
          + '" stroke-width="' + (s * 0.025) + '"')
      + '><title>' + b.view + '</title></circle>';
    if (b.label) {
      out += '<text x="' + b.x.toFixed(1) + '" y="' + (b.y + r * 0.36).toFixed(1) + '"'
        + ' text-anchor="middle" font-size="' + (s * 0.15)
        + '" fill="#111" font-family="var(--vscode-font-family)">' + b.label + '</text>';
    }
    out += '</g>';
  }
  return out;
}

/** The camera for a named view, or undefined. */
function viewFor(name) {
  const v = VIEWS[name];
  return v ? { yaw: v.yaw, pitch: v.pitch } : undefined;
}

/** The same functions, as source, for the webview - see relicView3d.clientBundle. */
function clientBundle() {
  return 'const NAV_BALLS = ' + JSON.stringify(BALLS) + ';\n'
    + 'const NAV_VIEWS = ' + JSON.stringify(VIEWS) + ';\n'
    + balls.toString().replace('BALLS', 'NAV_BALLS') + '\n'
    + navSvg.toString() + '\n';
}

module.exports = { balls, navSvg, viewFor, clientBundle, VIEWS, BALLS };
