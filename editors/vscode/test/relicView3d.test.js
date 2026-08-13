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
  '### [core](core)', '---', 'Relic: o', 'Solid: sphere, 0, 0, 0, 320', '---', '',
  '### [mouth](mouth)', '---', 'Relic: o', 'Point: -1500, 0, 0', 'Roles: entrance', '---', '',
  '### [cache](cache)', '---', 'Relic: o', 'Point: 200, 0, 300', 'Roles: item', '---'].join('\n');
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
  + rel.solids.length + rel.passages.length + rel.points.length);
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
const page = V.render([rel], 'N', 0);
// There is ONE view. The toggle that used to sit here was a camera angle wearing a
// button, and the second renderer behind it had already drifted from this one.
check('one scene, no toggle',
  page.indexOf('id="scene3"') >= 0 && page.indexOf('id="plan"') < 0
  && page.indexOf('id="m3d"') < 0);
check('the plan verbs are all here',
  ['id="grid3"', 'id="lab3g"', 'id="insp"', 'id="add"', 'id="del"', 'id="navg"']
    .every((t) => page.indexOf(t) >= 0));
check('...and it says which gestures it has', /MIDDLE-drag to orbit/.test(page));

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
  sel.indexOf('REL.chambers.concat(REL.boxes,REL.solids,REL.points)') >= 0);

// --- a gesture must always end ----------------------------------------------
// Reported from use: after a gizmo drag the mouse felt captured and nothing else worked.
// A drag lives between mousedown and mouseup, so ANY swallowed mouseup leaves it set and
// every later movement keeps dragging with no button held. Finishing a drag rewrites the
// document, and that edit can move focus off the webview - so the release really does
// land somewhere else sometimes.
check('one place ends a gesture', sel.indexOf('function endGesture()') >= 0);
check('a mouse moving with no button held cancels the drag',
  sel.indexOf('!e.buttons&&(move||orbit||pan||size||link)') >= 0);
check('the state comes back even if the write post throws',
  sel.indexOf('}finally{endGesture();}') >= 0);
check('losing focus mid-drag ends it rather than waiting for a release',
  sel.indexOf('"blur",endGesture') >= 0);
check('so does the pointer being cancelled', sel.indexOf('pointercancel') >= 0);

// The plan view has the same shape and had the same hole.
// The same teardown covers every gesture the one view has.
check('a stuck link is cleared with the rest',
  sel.indexOf('move||orbit||pan||size||link') >= 0);

// --- orbiting around what you are looking at --------------------------------
// Reported from use: orbiting lost the selection, and turned about the world origin -
// which swings the thing you are working on out of frame, worst exactly when you have
// zoomed in on it.
check('starting an orbit keeps the selection',
  sel.indexOf('else{sel=null;orbit=') < 0);
check('the view turns about the SELECTION when there is one',
  sel.indexOf('function pivot(){const p=partOf(sel);if(p)return p;') >= 0);
check('...and about the middle of the relic when there is not',
  sel.indexOf('x/all.length') >= 0);
// A press that never became a drag is a click, and a click on nothing deselects. Told
// apart at mouseup, because at mousedown they are still the same event.
check('a click on empty space still deselects',
  sel.indexOf('orbit&&!orbit.moved&&sel') >= 0);

// The pivot hold, as arithmetic rather than as a string match. Slide the viewBox by
// exactly how far the pivot moved and it lands back on the same pixel.
const P = { x: 3000, y: 0, z: 2500 };
const vb0 = { x: -500, y: -500, w: 4000, h: 3000 };
const c0 = { yaw: 0.6, pitch: 0.5 }, c1 = { yaw: 1.4, pitch: 0.2 };
const pb = V3.project(P, c0), pa = V3.project(P, c1);
const vb1 = V3.holdPivot(vb0, pb, pa);
check('the pivot keeps its place in the frame across an orbit step',
  near(pb.x - vb0.x, pa.x - vb1.x, 1e-9) && near(pb.y - vb0.y, pa.y - vb1.y, 1e-9));
check('...without changing the zoom', vb1.w === vb0.w && vb1.h === vb0.h);
check('a pivot that did not move does not move the frame', (() => {
  const same = V3.holdPivot(vb0, pb, pb);
  return same.x === vb0.x && same.y === vb0.y;
})());
check('the page uses that function, not its own copy of the sum',
  sel.indexOf('vb=holdPivot(vb,orbit.s,a)') >= 0);

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
  page.indexOf('id="navg"') >= 0 && page.indexOf('viewBox="0 0 100 100"') >= 0);
check('the toolbar names the three views', (page.match(/class="vw"/g) || []).length === 3);
check('...and says which axis each one is', /Look down the Y axis/.test(page));

// --- the size gizmo ---------------------------------------------------------
const chamber = G.sizeHandles({ x: 0, y: 0, z: 0, r: 900 }, cam, V3.project);
check('a chamber has exactly one size handle, its radius',
  chamber.length === 1 && chamber[0].field === 'r');
// Under an orthographic camera the circle IS the sphere, so the rim is at exactly r from
// the centre from every angle - which is why the radius drag needs no axis at all.
check('the radius handle sits on the rim', near(chamber[0].len, 900));
check('a radius handle is draggable from any angle',
  G.sizeHandles({ x: 0, y: 0, z: 0, r: 900 }, V3.topDown(), V3.project)[0].draggable);
const box = G.sizeHandles({ x: 0, y: 0, z: 0, hx: 400, hy: 200, hz: 300 }, cam, V3.project);
// SIX handles, one per FACE. A single handle per axis can only grow a box about its
// centre, so dragging the right wall moves the left one too - the classic complaint about
// box editors, and wrong for the job here: boxes are laid out by dragging a wall until it
// meets its neighbour.
check('a box has one handle per face',
  box.length === 6 && box.map((h) => (h.sign > 0 ? '+' : '-') + h.axis).join(' ')
  === '+x -x +y -y +z -z');
check('...each carrying its own half-extent',
  box.filter((h) => h.field === 'hx').every((h) => h.value === 400));
check('...and named as a wall in its tooltip',
  G.sizeSvg({ x: 0, y: 0, z: 0, hx: 400, hy: 200, hz: 300 }, cam, V3.project, 300)
    .indexOf('wall') >= 0);
check('a box half-extent goes edge-on like a move axis does',
  !G.sizeHandles({ x: 0, y: 0, z: 0, hx: 400, hy: 200, hz: 300 },
                 V3.topDown(), V3.project).find((h) => h.axis === 'y').draggable);
// The arithmetic of a one-sided resize, which is the whole of it: the dragged wall moves
// by the drag, the opposite one does not move at all. Both the size and the centre take
// half - and `Box:` holds them on the same line, so it stays ONE write.
check('dragging a wall leaves the opposite wall where it was', (() => {
  const half = 900, centre = 3600, disp = 400;
  const v = half + disp / 2, c = centre + disp / 2;
  return (c - v) === (centre - half) && (c + v) === (centre + half + disp);
})());
check('...and the same going the other way', (() => {
  const half = 900, centre = 3600, disp = -400, sign = -1;
  const v = half + sign * disp / 2, c = centre + disp / 2;
  return (c + v) === (centre + half) && (c - v) === (centre - half + disp);
})());
check('the page moves the centre with the size',
  sel.indexOf('size.p[c]=Math.round(size.oc[c]+disp/2)') >= 0);
check('...and writes both, still on one line',
  sel.indexOf('pa.x=size.p.x') >= 0);
// A sphere has no faces, so its one number stays symmetric.
check('a chamber keeps a single symmetric radius handle',
  G.sizeHandles({ x: 0, y: 0, z: 0, r: 900 }, cam, V3.project).length === 1);

check('a part with no size gets no handle',
  G.sizeHandles({ x: 0, y: 0, z: 0 }, cam, V3.project).length === 0);
check('a size drag writes through the same field message',
  sel.indexOf('pa[size.field]=size.p[size.field]') >= 0);
check('a size is never written as zero - lint rejects it and the volume refuses it',
  sel.indexOf('v=Math.max(1,Math.round(v))') >= 0);
check('a stuck size drag is cleared with everything else',
  sel.indexOf('move||orbit||pan||size') >= 0);

// --- Blender's mouse convention ---------------------------------------------
// Middle drags orbit, SHIFT-middle pans, the wheel zooms. Worth copying for more than
// familiarity: it leaves the LEFT button entirely to the work - select, move, size,
// connect - which is the only way those coexist without a modifier each.
check('the middle button navigates', sel.indexOf('e.button===1') >= 0);
check('...and SHIFT-middle pans', /button===1[\s\S]{0,120}shiftKey\)\{pan=/.test(sel));
// Without this the browser's middle-click autoscroll hijacks the very gesture we bind.
check('middle-click autoscroll is prevented', /button===1\)\{e.preventDefault/.test(sel));
check('the left button is left to the work', sel.indexOf('if(e.button!==0)return;') >= 0);

// --- the plan's own verbs, now in 3D ----------------------------------------
check('the ground grid is drawn in the WORLD, so it tilts with the view',
  V3.groundGrid(rel, cam, 12000).length > 0
  && V3.gridSvg(rel, cam, 12000, 12000).indexOf('<line') >= 0);
check('...at the same 1k/10k spacing the game uses',
  V3.GRID_MINOR === 1000 && V3.GRID_MAJOR === 10000);
// Past a few hundred lines a grid stops being a ruler and becomes a grey wash.
check('a huge span thins to major lines only',
  V3.groundGrid(rel, cam, 400000).length < V3.groundGrid(rel, cam, 12000).length * 4);
// The plan fans by world row; here it must be by PROJECTED position, because two chambers
// far apart in the world can land on the same pixel from one angle and not another.
const rows = V3.labelRows(V3.scene(rel, cam), 400);
check('labels fan in screen space so they never collide',
  rows.every((n, i, a) => i === 0 || n.ly - a[i - 1].ly >= 399.9));
check('...with a leader line when one is pushed off its part',
  V3.labelSvg(V3.scene(rel, cam), 350).indexOf('<line') >= 0);
check('SHIFT-drag between parts connects them, same modifier as the plan',
  sel.indexOf('link={from:g2.dataset.key,to:null}') >= 0 && sel.indexOf('type:"link"') >= 0);
check('...but never to a solid, which is subtracted space rather than a room',
  sel.indexOf('REL.solids.some') >= 0);
check('Add and Delete are here too',
  sel.indexOf('type:"add"') >= 0 && sel.indexOf('type:"remove"') >= 0);
// "Where I am looking" needs a height as well as a place, and the pivot's is the only one
// the author has expressed an opinion about.
check('a new chamber lands where you are looking, on the pivot floor',
  sel.indexOf('unproject(vb.x+vb.w/2,vb.y+vb.h/2,cam,Math.round(pivot().y))') >= 0);

// --- the right-click menu ---------------------------------------------------
check('right-click opens a menu', sel.indexOf('addEventListener("contextmenu"') >= 0);
// The one thing a toolbar button cannot say: HERE. The click point unprojects to a spot.
check('...whose Add means HERE, not the middle of the view',
  sel.indexOf('unproject(q.x,q.y,cam') >= 0 && sel.indexOf('Add chamber here') >= 0);
check('...and can frame or delete what was clicked',
  sel.indexOf('Frame it') >= 0 && sel.indexOf('Delete "+k') >= 0);
check('a click elsewhere closes it', sel.indexOf('!ctx.contains(e.target)') >= 0);
// ...in the CAPTURE phase, so a press the scene handles still dismisses it first.
check('...before whatever was clicked gets the press',
  /!ctx.contains\(e.target\)\)hideCtx\(\);\},true\)/.test(sel.replace(/'\s*\+\s*'/g, '')));

// --- a wheel during a drag is never a zoom -----------------------------------
// Reported: middle-drag orbited in one direction, then went wonky and zoomed the moment
// the direction changed. Whatever produced the wheel event - a browser that armed
// autoscroll before we refused it, a tilt wheel, a trackpad - the author has a button held
// and is orbiting, and zooming underneath that is never what was meant.
check('a wheel is ignored while a gesture is in progress',
  sel.indexOf('if(orbit||pan||move||size||link)return;') >= 0);
// A viewBox with a NaN in it is IGNORED by the browser, which shows as the view snapping
// to some other framing - indistinguishable from a zoom, and untraceable to the sum that
// produced it.
check('a non-finite viewBox is never written',
  sel.indexOf('!isFinite(vb.x)') >= 0 && sel.indexOf('vb.w<=0') >= 0);
// outerHTML on an SVG element parses its string as HTML, so the new nodes land in the
// HTML namespace and never render - the grid simply disappears after the first redraw.
check('the grid redraws into a stable wrapper, not through outerHTML',
  sel.indexOf('getElementById("grid3g")') >= 0 && sel.indexOf('outerHTML') < 0);

// unproject is what all of that rests on: a screen point is a whole LINE in the world,
// so it only has an answer once a height is pinned.
[{ yaw: 0.6, pitch: 0.5 }, { yaw: 0, pitch: Math.PI / 2 }, { yaw: 2.1, pitch: 0.9 }].forEach((c, i) => {
  const P = { x: 3000, y: 0, z: -2500 };
  const s2 = V3.project(P, c);
  const b2 = V3.unproject(s2.x, s2.y, c, 0);
  check('unproject round-trips a ground point at angle ' + i,
    near(b2.x, P.x, 1e-6) && near(b2.z, P.z, 1e-6));
});
check('...and on a raised floor too', (() => {
  const P = { x: 1000, y: 1500, z: 500 }, c = { yaw: 0.6, pitch: 0.5 };
  const s2 = V3.project(P, c), b2 = V3.unproject(s2.x, s2.y, c, 1500);
  return near(b2.x, P.x, 1e-6) && near(b2.z, P.z, 1e-6);
})());
// Along the horizon the horizontal plane is edge-on and the answer is a whole line, so it
// must fall back rather than divide by zero.
check('an edge-on floor falls back instead of returning nonsense',
  isFinite(V3.unproject(10, 20, { yaw: 0, pitch: 0 }, 0).z));

// --- the navigation gizmo, continued ----------------------------------------
// Clicking the axis already facing you flips to the far side, which is what Blender does
// and what the widget's own picture demands: looking down an axis puts BOTH of its balls
// on the same pixel, so the near one is the only thing you can hit. Without the flip, that
// ball is the one control on the widget that does nothing.
check('clicking the axis you are looking down flips to the other side',
  N.nextView('top', N.viewFor('top')) === 'bottom'
  && N.nextView('bottom', N.viewFor('bottom')) === 'top');
check('...for every axis',
  N.nextView('front', N.viewFor('front')) === 'back'
  && N.nextView('right', N.viewFor('right')) === 'left');
check('clicking a DIFFERENT axis just goes there',
  N.nextView('front', N.viewFor('top')) === 'front');
check('mid-orbit, nothing is being looked down, so nothing flips',
  N.nextView('top', { yaw: 0.6, pitch: 0.5 }) === 'top');
check('every view has an opposite',
  Object.keys(N.VIEWS).every((k) => N.OPPOSITE[k] && N.VIEWS[N.OPPOSITE[k]]));
check('the page uses the flip rather than the raw name',
  sel.indexOf('NAV_VIEWS[nextView(b.dataset.view,cam)]') >= 0);

// --- the inspector ----------------------------------------------------------
// Dragging is not a substitute for typing: an author who wants a radius of exactly 900
// should not have to land it with a mouse.
check('the inspector fills from the selection', sel.indexOf('function showInsp()') >= 0);
check('...and a typed number writes through the same field message',
  sel.indexOf('vscode.postMessage({type:"field",key:p.key,patch:pa})') >= 0);
check('...never as zero, which lint rejects and the volume refuses',
  sel.indexOf('Math.max(1,Math.round(v))') >= 0);
check('half-extent fields appear only for a box', sel.indexOf('"lhx","lhy","lhz"') >= 0);
// A rename rewrites the HEADING rather than a fence field, so it travels as its own
// message - but it is still exactly one line and one undo step.
check('a rename posts its own message', sel.indexOf('type:"name"') >= 0);
// Refilling the box you are typing in would fight the cursor on every keystroke.
check('...and the field you are typing in is not overwritten under you',
  sel.indexOf('document.activeElement!==nm') >= 0);
check('the key is shown beside it, so a rename cannot be mistaken for one',
  sel.indexOf('passages use it') >= 0);

// --- embedding the scene safely ---------------------------------------------
// The relic file is data from wherever the mission came from. JSON.stringify does not
// escape `<`, so a chamber named `x</script><b>` ends the script element and starts
// writing markup - an injection, not a typo.
const evil = 'x</' + 'script><b>';
check('a name cannot close the script tag', Orbit.embed({ n: evil }).indexOf('<') < 0);
check('...and the JSON still parses to what it was',
  JSON.parse(Orbit.embed({ n: evil })).n === evil);
// Line terminators to JavaScript, but not to JSON.
check('U+2028 and U+2029 are escaped too',
  Orbit.embed({ n: 'a b c' }).indexOf(' ') < 0);

// --- three things reported from use ------------------------------------------
// "The camera navigator does not work any more."
// nextView's SOURCE refers to VIEWS and OPPOSITE by those names, so emitting only an
// aliased copy left every click throwing ReferenceError before it reached the camera -
// and a handler that throws looks exactly like one that was never wired up.
const navPage = new Function(N.clientBundle()
  + '; return {nextView:nextView,navSvg:navSvg,balls:balls};')();
check('the page can actually run nextView',
  navPage.nextView('top', N.viewFor('top')) === 'bottom');
check('...and it agrees with the module',
  navPage.nextView('front', N.viewFor('front')) === N.nextView('front', N.viewFor('front')));
check('...and so does the widget it draws',
  navPage.navSvg(cam, V3.project, 100) === N.navSvg(cam, V3.project, 100));

// "Middle button down zooms in so I cannot orbit or pan."
// The browser arms its autoscroll on the middle press. Refusing it on the scene's own
// mousedown is too late and too narrow - the press can land on a child, and by the time
// it bubbles the scroll mode is armed, which then reads every drag as a scroll.
check('the middle press is refused at the DOCUMENT, in the capture phase',
  /document.addEventListener\("mousedown",function\(e\)\{if\(e.button===1\)e.preventDefault\(\);\},true\)/
    .test(sel.replace(/'\s*\+\s*'/g, '')));
check('...and auxclick with it, which fires after the release',
  sel.indexOf('auxclick') >= 0);

// "The names do not move when you change the camera."
// The labels are part of the PICTURE. Rendering them once, server-side, left the names
// sitting where the chambers used to be.
check('a redraw redraws the labels', sel.indexOf('lb.innerHTML=labelSvg(scene(REL,cam)') >= 0);
check('...and the ground grid, which turns with the view too',
  sel.indexOf('gr.innerHTML=gridSvg(REL,cam') >= 0);
check('...and the navigation widget, which shows where the camera IS',
  sel.indexOf('nv.innerHTML=navSvg(cam,project,100)') >= 0);
// Every piece of the picture is a function of the camera, so every piece has to be
// recomputed when it changes. This is the list.
check('nothing in the picture is drawn only once',
  ['scene3g', 'grid3', 'lab3g', 'navg'].every((id) => sel.indexOf(id) >= 0));

// Every bundle, RUN. A clientBundle that omits something its own functions reference is
// not a missing feature - it is a ReferenceError at the moment of use, and the symptom is
// a control that appears to have been forgotten rather than one that is broken. Whole
// widget, one omitted name.
[['relicView3d', V3.clientBundle(), 'body(REL,CAM)'],
 ['relicGizmo', G.clientBundle(), 'gizmoSvg({x:0,y:0,z:0,r:100},CAM,100,PROJECT)'],
 ['relicNav', N.clientBundle(), 'navSvg(CAM,PROJECT,100)+nextView("top",CAM)'],
].forEach(([name, src, call]) => {
  check(name + ' evaluates and runs standalone in the page', (() => {
    try {
      new Function('REL', 'CAM', 'PROJECT', src + '; return ' + call + ';')(
        rel, cam, V3.project);
      return true;
    } catch (e) { return false; }
  })());
});

// A BOX HAS TO BE SELECTABLE, or its gizmos are unreachable rather than missing.
// Its only hit target used to be a 60-unit circle with fill="none" - an unfilled shape is
// not hit-testable in its interior - so a box could never be clicked, and both the move
// and the resize handles existed the whole time with no way to reach them.
check('the whole box is the hit target, not a dot at its middle', (() => {
  const h = V3.body(rel, cam);
  const at = h.indexOf('data-key="hall"');
  if (at < 0) { return false; }
  const grp = h.slice(at, h.indexOf('</g>', at));
  // A stroked line IS hit-testable along its stroke, so every edge selects the box.
  return (grp.match(/<line/g) || []).length === 12
    && grp.indexOf('fill="#9ece6a" fill-opacity') >= 0
    && h.indexOf('r="60" fill="none"') < 0;
})());

// --- a shift-drag has to show itself ----------------------------------------
// Without a line following the cursor the gesture is invisible until it succeeds - and
// when it fails, indistinguishable from having done nothing at all.
check('the band is drawn while linking', sel.indexOf('getElementById("link3")') >= 0);
check('...and cleared when the gesture ends',
  sel.indexOf('if(ln0)ln0.innerHTML=""') >= 0);
check('a valid drop target lights up', sel.indexOf('classList.add("tgt")') >= 0);
// A solid is subtracted space, not a room, so it can never be an end of a passage. Saying
// that by not lighting it up beats refusing on release.
check('a solid is never offered as a target', sel.indexOf('REL.solids.some') >= 0);
check('nor is the part you started from', sel.indexOf('k2!==link.from') >= 0);
// The release connects EXACTLY what the picture was offering.
check('the release uses the target the band vetted',
  sel.indexOf('if(link&&link.to)vscode.postMessage') >= 0);

// The band's markup is built by concatenation in the page, so evaluate it the way the page
// would rather than trust that it reads correctly.
check('the band evaluates to a real line', (() => {
  const i = sel.indexOf('ln.innerHTML=') + 13;
  const expr = sel.slice(i, sel.indexOf(';}', i));
  const out = new Function('s0', 'q', 'good', 'vb', 'return ' + expr)(
    { x: 10, y: 20 }, { x: 90, y: 80 }, true, { w: 1000 });
  return /^<line x1="10" y1="20" x2="90" y2="80"/.test(out)
    && out.indexOf('stroke-dasharray') > 0;
})());

// --- solids and points in the editor ----------------------------------------
// A solid could barely be selected: fill="none" is not hit-testable in its interior, and a
// DASHED stroke has gaps, so the only clickable part was the dashes. Its move and size
// gizmos existed the whole time with no way to reach them - the same defect the box had.
check('a solid has a fill to click, while still reading as a hole', (() => {
  const h = V3.body(rel, cam);
  const at = h.indexOf('data-key="core"');
  if (at < 0) { return false; }
  const grp = h.slice(h.lastIndexOf('<g class', at), h.indexOf('</g>', at));
  return grp.indexOf('fill="#f7768e" fill-opacity="0.08"') >= 0
    && grp.indexOf('stroke-dasharray') >= 0;
})());
check('...and its radius handle works', (() => {
  const s = rel.solids.find((x) => x.shape === 'sphere');
  const hs = G.sizeHandles(s, cam, V3.project);
  return hs.length === 1 && hs[0].field === 'r';
})());
check('Add solid is offered and wired',
  page.indexOf('id="addsolid"') >= 0 && sel.indexOf('type:"addsolid"') >= 0);
// The numbers are identical, so flipping is one line - and it is the natural way to work.
check('the subtracted toggle is offered and wired',
  page.indexOf('id="fsub"') >= 0 && sel.indexOf('type:"kind"') >= 0);

// A POINT is a place, not a shape: no radius, no extents, nothing navigable.
check('a point is drawn', V3.body(rel, cam).indexOf('data-key="mouth"') >= 0);
check('...an entrance is called out, because it is the one a crew has to find',
  /data-key="mouth"[\s\S]{0,300}#7dcfff/.test(V3.body(rel, cam)));
check('...it can be selected and moved',
  sel.indexOf('REL.chambers.concat(REL.boxes,REL.solids,REL.points)') >= 0);
check('...but has no size to drag', (() => {
  const t = rel.points[0];
  return G.sizeHandles(t, cam, V3.project).length === 0
    && G.handles(t, cam, 600, V3.project).length === 3;
})());
check('...and is not counted as geometry',
  rel.points.length === 2 && rel.chambers.length === 2);

// A SOLID IS DRAWN AS ITS SHAPE.
// Reported from use: a box marked subtracted "turns into a sphere". The file was right -
// `Solid: box, 3600, 0, 2900, 900, 260, 380` - and the picture was not, which is the worse
// way round, because you go and correct something that was never wrong.
{
  const R2 = require('../media/relicModel.js');
  const flipped = R2.parse(R2.setKind(DOC, R2.parse(DOC).relics[0].boxes[0], 'solid'))
    .relics[0];
  const h = V3.body(flipped, cam);
  const at = h.indexOf('data-key="hall"');
  const grp = h.slice(h.lastIndexOf('<g class', at), h.indexOf('</g>', at));
  check('a box solid draws as a box, not a circle',
    (grp.match(/<line/g) || []).length === 12 && grp.indexOf('<circle') >= 0);
  check('...still dashed, because it is a hole', grp.indexOf('stroke-dasharray') >= 0);
  // A wireframe is all gaps, so the centre patch is what makes it selectable.
  check('...with a patch to click', grp.indexOf('fill-opacity="0.10"') >= 0);
  check('...and its half-extents survive the flip', (() => {
    const s = flipped.solids.find((x) => x.key === 'hall');
    return s.hx === 400 && s.hy === 200 && s.hz === 300;
  })());
  check('...so it resizes by its faces, like a box', (() => {
    const s = flipped.solids.find((x) => x.key === 'hall');
    return G.sizeHandles(s, cam, V3.project).length === 6;
  })());
}
// The column down a shaft is a tube between two endpoints, not a disc at its middle.
check('a capsule solid draws along its axis', (() => {
  const NLC = String.fromCharCode(10);
  const CAP = DOC + NLC + ['', '### [col](col)', '---', 'Relic: o',
    'Solid: capsule, 0, -2000, 0, 0, 2000, 0, 130', '---'].join(NLC);
  const r2 = require('../media/relicModel.js').parse(CAP).relics[0];
  const h = V3.body(r2, cam);
  const at = h.indexOf('data-key="col"');
  const grp = h.slice(h.lastIndexOf('<g class', at), h.indexOf('</g>', at));
  return (grp.match(/<line/g) || []).length === 2 && grp.indexOf('<circle') < 0;
})());

// Adding a point, and saying what it is for - the answer to "how do I add an item".
check('Add point is offered, on the toolbar and in the menu',
  page.indexOf('id="addpoint"') >= 0 && sel.indexOf('type:"addpoint"') >= 0
  && sel.indexOf('Add point here') >= 0);
check('the roles field is offered and wired',
  page.indexOf('id="froles"') >= 0 && sel.indexOf('type:"roles"') >= 0);
check('...and is not refilled while you are typing in it',
  sel.indexOf('document.activeElement!==rl') >= 0);
// Roles only mean something on a point today, so the field hides for a chamber.
check('roles are shown only where they apply', sel.indexOf('p.roles===undefined') >= 0);


// --- authored contents ------------------------------------------------------
// What is IN the relic - the Red Beacon in the vault, the raiders that wake at the core.
// The panel is where an author writes it, so every box here is asserted WIRED, not merely
// present: a rendered control with no handler looks identical until you click it.
const CDOC = ['# [T](t)', '', '## [Items](items)', '',
  '### [Red Beacon](red_beacon)', '---', 'Type: item', '---', '',
  '## [Relics](relics)', '',
  '### [O](o)', '---', 'Loc: 0,0,0', '---', '',
  '### [vault](vault)', '---', 'Relic: o', 'Chamber: 0, 0, 0, 400',
  'Item: red_beacon', 'Qty: 2', 'Starts when: reach vault_door 900', '---', '',
  '### [plain](plain)', '---', 'Relic: o', 'Chamber: 2000, 0, 0, 400', '---', '',
  '### [ambush](ambush)', '---', 'Relic: o', 'Point: 0, 0, 900',
  'Spawn: raider x2', '---'].join('\n');
const crel = R.parse(CDOC).relics[0];
const cpage = V.render([crel], 'n', 0, null, false, null, null, R.itemKeys(CDOC));
const csel = cpage.slice(cpage.indexOf('<script'));

check('contents hang off any part, not only a point',
  crel.chambers[0].item === 'red_beacon' && crel.chambers[0].qty === '2'
  && crel.points[0].spawn === 'raider x2');
check('a part with no contents says so rather than guessing',
  crel.chambers[1].hasContents === false && crel.chambers[0].hasContents === true);
check('the four contents boxes are offered',
  ['fitem', 'fqty', 'fspawn', 'fwhen'].every((id) => cpage.indexOf('id="' + id + '"') >= 0));
check('...and every one of them writes a line',
  csel.indexOf('type:"linefield"') >= 0 && csel.indexOf('"starts when"') >= 0
  && csel.indexOf('CFIELDS') >= 0);
check('...and none is refilled while you are typing in it',
  csel.indexOf('document.activeElement!==n') >= 0);
check('the item box offers the file\'s own item keys',
  cpage.indexOf('id="items"') >= 0 && cpage.indexOf('value="red_beacon"') >= 0);
// The one-glance question the view exists to answer.
check('a furnished part is marked in the view, an empty one is not',
  (V3.body(crel, V3.defaultCamera()).match(/class="cm"/g) || []).length === 2);
check('the mark travels in the client bundle', (() => {
  const f = new Function(V3.clientBundle() + '; return contentsMark;')();
  return f({ hasContents: true, at: { x: 0, y: 0 } }, '1').indexOf('class="cm"') >= 0
    && f({ hasContents: false, at: { x: 0, y: 0 } }, '1') === '';
})());

// The model writes one line, and emptying a box removes it rather than leaving `Item:`
// with nothing after it - a blank field is a lint finding waiting to happen.
const vaultPart = crel.chambers[0];
check('a contents edit writes exactly one line',
  R.setLineField(CDOC, vaultPart, 'qty', '5').split('\n').length
    === CDOC.split('\n').length);
check('emptying a contents box removes its line',
  R.setLineField(CDOC, vaultPart, 'qty', '').indexOf('Qty:') < 0);
check('a field the part does not carry yet is added under it',
  R.setLineField(CDOC, crel.chambers[1], 'item', 'torch').indexOf('Item: torch') > 0);
check('the label is written the way an author would write it',
  R.setLineField(CDOC, crel.chambers[1], 'starts when', 'signal x')
    .indexOf('Starts when: signal x') > 0);
check('item keys come from an Items section and from Type: item',
  R.itemKeys(CDOC).join(',') === 'red_beacon');

// The page must PARSE. A name collision here (the gizmo once exported `svg`, which the
// page already binds to its element) blanks the view with nothing in the log.
check('the page script parses', (() => {
  try { new Function(sel.replace('acquireVsCodeApi()', '({postMessage:function(){}})')); return true; }
  catch (e) { return false; }
})());

console.log('\n' + (fail ? fail + ' FAILED' : 'all relicView3d tests passed') + '\n');
process.exit(fail ? 1 : 0);
