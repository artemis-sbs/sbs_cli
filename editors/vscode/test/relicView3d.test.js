// The 3D preview's maths, and the one thing that makes it a picture rather than a mess:
// draw order.
//
// It exists because booting the mission is not a way to look at a relic - it can sit
// 80,000 units from the spawn, or not exist until a quest spawns it. So this has to be
// right with nothing running.
'use strict';

const V3 = require('../media/relicView3d.js');
const Orbit = require('../media/relicOrbit.js');
const R = require('../media/relicModel.js');

let pass = 0, fail = 0;
function check(name, ok) {
  if (ok) { pass++; console.log('  ok  - ' + name); }
  else { fail++; console.log('  FAIL- ' + name); }
}
const near = (a, b, eps) => Math.abs(a - b) < (eps || 0.001);

const DOC = ['# [T](t)', '', '## [Relics](relics)', '',
  '### [O](o)', '---', 'Loc: 0,0,0', '---', '',
  '### [hub](hub)', '---', 'Relic: o', 'Chamber: 0, 0, 0, 900',
  'Passage to: high 300', '---', '',
  '### [high](high)', '---', 'Relic: o', 'Chamber: 0, 2000, 0, 500', '---', '',
  '### [hall](hall)', '---', 'Relic: o', 'Box: 3000, 0, 0, 400, 200, 300', '---', '',
  '### [core](core)', '---', 'Relic: o', 'Solid: sphere, 0, 0, 0, 320', '---'].join('\n');
const rel = R.parse(DOC).relics[0];

console.log('\nrelicView3d\n');

// --- axes -------------------------------------------------------------------
// The two views have to be legible as the same relic, and the plan is the one that was
// checked against the game's own radar. So top-down here must reproduce it exactly.
check('looking straight down reproduces the plan (+Z is up the screen)',
  near(V3.project({ x: 100, y: 0, z: 500 }, V3.topDown()).y, -500));
check('...and x is unchanged by it',
  near(V3.project({ x: 100, y: 0, z: 500 }, V3.topDown()).x, 100));
check('at the horizon, altitude is up the screen',
  near(V3.project({ x: 0, y: 900, z: 0 }, { yaw: 0, pitch: 0 }).y, -900));
check('height is INVISIBLE from straight down - which is what the plan warns about',
  near(V3.project({ x: 0, y: 4000, z: 0 }, V3.topDown()).x, 0)
  && near(V3.project({ x: 0, y: 4000, z: 0 }, V3.topDown()).y, 0));
check('a yaw of a quarter turn swaps x and z',
  near(V3.project({ x: 1000, y: 0, z: 0 }, { yaw: Math.PI / 2, pitch: 0 }).x, 0, 0.01));

// --- draw order -------------------------------------------------------------
// Painter's algorithm is the whole renderer. Get this wrong and a far chamber draws over
// the wall in front of it, which does not look like a bug - it looks like the relic.
const items = V3.scene(rel, V3.defaultCamera());
check('the scene sorts far to near',
  items.every((it, i, a) => i === 0 || a[i - 1].depth >= it.depth));
check('every primitive is in it', items.length === rel.chambers.length + rel.boxes.length
  + rel.solids.length + rel.passages.length);
check('a subtracted solid draws in FRONT of the chamber it is inside',
  (() => {
    const cam = V3.defaultCamera();
    const s = items.find((i) => i.kind === 'solid');
    const h = items.find((i) => i.kind === 'chamber' && i.key === 'hub');
    return items.indexOf(s) > items.indexOf(h);   // later = nearer = drawn on top
  })());

// --- shapes -----------------------------------------------------------------
const svg = V3.body(rel, V3.defaultCamera());
check('a chamber is a circle', svg.indexOf('<circle') >= 0);
check('a passage is a thick round-capped line',
  svg.indexOf('stroke-linecap="round"') >= 0);
check('a box is drawn as a wireframe, all 12 edges',
  (svg.match(/stroke="#9ece6a"/g) || []).length === 12);
check('a box has 8 corners', V3.boxCorners(rel.boxes[0], V3.defaultCamera()).length === 8);
check('a subtracted solid is a HOLE - unfilled and dashed, never another room',
  svg.indexOf('stroke-dasharray') >= 0 && svg.indexOf('(subtracted)') >= 0);
check('nearer is brighter', V3.shade(0, 0, 10) > V3.shade(10, 0, 10));
check('a dangling passage is omitted rather than crashing the view',
  V3.scene({ chambers: [], boxes: [], solids: [],
             passages: [{ from: 'nope', to: 'gone', radius: 100 }] },
           V3.defaultCamera()).length === 0);
check('an empty relic still frames something', V3.extent([]).w > 0);

// --- the page runs the SAME code -------------------------------------------
// A hand-written copy of the projection in the page would drift from the one under test,
// and the drift would only show as a picture that disagrees with the plan.
const bundled = new Function(V3.clientBundle() + '; return body;')();
check('the webview bundle is the module, not a copy of it',
  bundled(rel, V3.defaultCamera()) === V3.body(rel, V3.defaultCamera()));

// --- interaction ------------------------------------------------------------
const s = Orbit.script(rel, V3.defaultCamera(), { x: 0, y: 0, w: 100, h: 100 });
check('drag orbits', s.indexOf('orbit={') >= 0 && s.indexOf('cam.yaw=orbit.yaw') >= 0);
check('SHIFT-drag pans', s.indexOf('e.shiftKey') >= 0 && s.indexOf('pan={') >= 0);
check('the wheel zooms', s.indexOf('addEventListener("wheel"') >= 0);
check('...about the cursor, not the middle',
  s.indexOf('getScreenCTM().inverse()') >= 0 && s.indexOf('w.x-(w.x-vb.x)*f') >= 0);
// Past straight down the scene mirrors and the relic appears to flip, which reads as a
// bug rather than a rotation.
check('pitch is clamped to a hemisphere', s.indexOf('Math.max(-1.5533') >= 0);
check('the angle AND the framing are reported back, so a redraw does not lose them',
  s.indexOf('type:"view3d"') >= 0 && s.indexOf('yaw:cam.yaw') >= 0);
check('the page carries only the geometry, not the source spans',
  JSON.stringify(Orbit.sceneData(rel)).indexOf('line') < 0);
check('no external anything for the CSP to block',
  s.indexOf('http') < 0 && s.indexOf('import(') < 0);

// --- the panel around it ----------------------------------------------------
const V = require('../media/relicView.js');
const plan = V.render([rel], 'N', 0);
const three = V.render([rel], 'N', 0, undefined, false, '3d');
check('the toolbar offers both views',
  plan.indexOf('id="m2d"') >= 0 && plan.indexOf('id="m3d"') >= 0);
check('the mode is posted as an intent, like every other gesture',
  plan.indexOf("type:'mode'") >= 0);
check('3d marks itself as the one you are in', three.indexOf('id="m3d" class="on"') >= 0);
check('plan is the default', plan.indexOf('id="m2d" class="on"') >= 0);
// Add and Delete edit the document and need a selection, which the 3D view has no way to
// make. A button that quietly does nothing is worse than no button.
check('3d hides the editing buttons',
  three.indexOf('id="add"') < 0 && three.indexOf('id="del"') < 0);
check('...and says which gestures it actually has', /drag to orbit/.test(three));
check('the two views never render together',
  (plan.indexOf('id="scene3"') < 0) && (three.indexOf('id="plan"') < 0));

// --- the move gizmo ---------------------------------------------------------
// A bare drag in a 3D view is ambiguous: the same mouse movement could mean any of a
// plane of world positions. Constraining each drag to ONE axis makes it answerable.
const G = require('../media/relicGizmo.js');
const cam = V3.defaultCamera();
const hs = G.handles({ x: 0, y: 0, z: 0 }, cam, 1000, V3.project);
check('three axes', hs.length === 3 && hs.map((h) => h.axis).join('') === 'xyz');
check('all three are draggable from a three-quarter view', hs.every((h) => h.draggable));

// The failure people report as "it jumped": an axis pointing at the camera collapses to
// a point on screen, so a pixel of mouse movement becomes thousands of units.
const down = G.handles({ x: 0, y: 0, z: 0 }, V3.topDown(), 1000, V3.project);
const yDown = down.find((h) => h.axis === 'y');
check('looking straight down, the height axis is edge-on', yDown.len < 1);
check('...and refuses to be dragged rather than obeying wildly', !yDown.draggable);
check('...while the other two still work',
  down.filter((h) => h.axis !== 'y').every((h) => h.draggable));
check('an edge-on handle says why in its tooltip',
  G.gizmoSvg({ x: 0, y: 0, z: 0 }, V3.topDown(), 1000, V3.project).indexOf('edge-on') >= 0);

// The projection of a mouse movement onto the axis, which IS the move.
const hx = hs.find((h) => h.axis === 'x');
check('dragging exactly along an axis moves exactly that far',
  near(G.along(hx, hx.dx, hx.dy), 1, 0.0001));
check('dragging across it does not move at all',
  near(G.along(hx, -hx.dy, hx.dx), 0, 0.0001));
check('dragging back moves back', near(G.along(hx, -hx.dx, -hx.dy), -1, 0.0001));
check('a collapsed axis yields no movement rather than infinity',
  G.along({ dx: 0, dy: 0 }, 100, 100) === 0);

// --- selecting and writing --------------------------------------------------
const sel = Orbit.script(rel, cam, { x: 0, y: 0, w: 100, h: 100 }, 'hub');
check('a part is selectable', sel.indexOf('data-key') >= 0 || sel.indexOf('sel=') >= 0);
check('a solid is selectable too',
  V3.body(rel, cam).indexOf('class="p3" data-key="core"') >= 0
  || Orbit.sceneData(rel).solids.every((s) => s.key !== undefined));
check('ESC deselects', sel.indexOf('Escape') >= 0);
// One write path: the gizmo posts the SAME message the plan view and the inspector post,
// so all three land on setPart and rewrite exactly one line.
check('a finished drag writes through the shared field message',
  sel.indexOf('type:"field"') >= 0 && sel.indexOf('patch:{x:') >= 0);
check('...carrying all three axes, since 3D can move any of them',
  /patch:\{x:[^}]*y:[^}]*z:/.test(sel));
check('a click that did not move writes nothing',
  sel.indexOf('move&&move.moved') >= 0);
check('the selection is reported so a redraw does not drop the gizmo',
  sel.indexOf('type:"sel3d"') >= 0);
check('a passage is not movable - it has no position of its own',
  sel.indexOf('REL.chambers.concat(REL.boxes,REL.solids)') >= 0);

// --- a gesture must always end ----------------------------------------------
// Reported from use: after a gizmo drag the mouse felt captured and nothing else worked.
// A drag lives between mousedown and mouseup, so ANY swallowed mouseup leaves it set and
// every later movement keeps dragging with no button held. Finishing a drag rewrites the
// document, and that edit can move focus off the webview - so the release really does
// land somewhere else sometimes.
check('one place ends a gesture', sel.indexOf('function endGesture()') >= 0);
check('a mouse moving with no button held cancels the drag',
  sel.indexOf('!e.buttons&&(move||orbit||pan||size)') >= 0);
check('the state comes back even if the write post throws',
  sel.indexOf('}finally{endGesture();}') >= 0);
check('losing focus mid-drag ends it rather than waiting for a release',
  sel.indexOf('"blur",endGesture') >= 0);
check('so does the pointer being cancelled', sel.indexOf('pointercancel') >= 0);

// The plan view has the same shape and had the same hole.
const planScript = V.render([rel], 'N', 0);
check('the plan view ends a gesture the same way',
  planScript.indexOf('function endGesture()') >= 0
  && planScript.indexOf('!e.buttons&&(drag||pan||link)') >= 0);
check('...and clears in a finally there too',
  planScript.indexOf('finally{endGesture();}') >= 0);

// --- the navigation gizmo ---------------------------------------------------
// Blender's control, NOT Blender's axes. Blender is Z-up; Cosmos is Y-up, because a
// chamber's second number is altitude. Anyone reading this widget as Blender's will reach
// for the wrong ball, so the mapping is asserted rather than left to a comment.
const N = require('../media/relicNav.js');
check('clicking Y looks down from above, and IS the plan view',
  N.viewFor('top').pitch === V3.topDown().pitch && N.viewFor('top').yaw === V3.topDown().yaw);
check('...so top puts +Z up the screen, exactly like the plan',
  near(V3.project({ x: 0, y: 0, z: 500 }, N.viewFor('top')).y, -500));
check('front looks down Z, so altitude is up the screen',
  near(V3.project({ x: 0, y: 900, z: 0 }, N.viewFor('front')).y, -900));
check('right looks down X, so Z runs across',
  near(V3.project({ x: 0, y: 0, z: 500 }, N.viewFor('right')).x, 500));
check('the Y ball is the one that means top, not the Z ball',
  N.BALLS.find((b) => b.label === 'Y').view === 'top'
  && N.BALLS.find((b) => b.label === 'Z').view === 'front');
check('every axis has both ends', N.BALLS.length === 6);
check('an unknown view is refused rather than guessed', N.viewFor('sideways') === undefined);
// Without the sort a ball behind the origin paints over one in front and the widget
// reads inside-out.
check('the balls sort back to front', (() => {
  const b = N.balls(V3.defaultCamera(), V3.project, 100);
  return b.every((x, i, a) => i === 0 || a[i - 1].depth >= x.depth);
})());
check('the widget is drawn in its own screen space, not the scene',
  three.indexOf('id="navg"') >= 0 && three.indexOf('viewBox="0 0 100 100"') >= 0);
check('the toolbar names the three views', (three.match(/class="vw"/g) || []).length === 3);
check('...and says which axis each one is', /Look down the Y axis/.test(three));

// --- the size gizmo ---------------------------------------------------------
const chamber = G.sizeHandles({ x: 0, y: 0, z: 0, r: 900 }, cam, V3.project);
check('a chamber has exactly one size handle, its radius',
  chamber.length === 1 && chamber[0].field === 'r');
// Under an orthographic camera the circle IS the sphere, so the rim is at exactly r from
// the centre from every angle - which is why the radius drag needs no axis at all.
check('the radius handle sits on the rim', near(chamber[0].len, 900));
check('a radius handle is draggable from any angle',
  G.sizeHandles({ x: 0, y: 0, z: 0, r: 900 }, V3.topDown(), V3.project)[0].draggable);
const box = G.sizeHandles({ x: 0, y: 0, z: 0, hx: 400, hy: 200, hz: 300, kind: 'box' }, cam, V3.project);
check('a box has three, its half-extents',
  box.map((h) => h.field).join(',') === 'hx,hy,hz');
check('...each carrying its own number', box.map((h) => h.value).join(',') === '400,200,300');
check('a box half-extent goes edge-on like a move axis does',
  !G.sizeHandles({ x: 0, y: 0, z: 0, hx: 400, hy: 200, hz: 300, kind: 'box' },
                 V3.topDown(), V3.project).find((h) => h.field === 'hy').draggable);
check('a part with no size gets no handle',
  G.sizeHandles({ x: 0, y: 0, z: 0 }, cam, V3.project).length === 0);
check('a size drag writes through the same field message',
  sel.indexOf('pa[size.field]=size.p[size.field]') >= 0);
check('a size is never written as zero - lint rejects it and the volume refuses it',
  sel.indexOf('v=Math.max(1,Math.round(v))') >= 0);
check('a stuck size drag is cleared with everything else',
  sel.indexOf('move||orbit||pan||size') >= 0);

// The page must PARSE. A name collision here (the gizmo once exported `svg`, which the
// page already binds to its element) blanks the view with nothing in the log.
check('the page script parses', (() => {
  try { new Function(sel.replace('acquireVsCodeApi()', '({postMessage:function(){}})')); return true; }
  catch (e) { return false; }
})());

console.log('\n' + (fail ? fail + ' FAILED' : 'all relicView3d tests passed') + '\n');
process.exit(fail ? 1 : 0);
