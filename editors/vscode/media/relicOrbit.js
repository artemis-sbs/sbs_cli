// The 3D view's in-page behaviour: orbit, pan, zoom, select, and move.
//
// Separate from relicView3d (the maths), relicGizmo (the handles) and relicView (the
// panel) because it is none of those - it is the string of JavaScript the webview runs,
// and keeping it out of the panel's template is what stops a quoting mistake here from
// breaking the plan view too.
//
// THE GESTURES, and why these ones:
//   click a part       select it, and put the move gizmo on it
//   drag an axis       move along that axis only - see relicGizmo for why one axis
//   drag anywhere else orbit. The view's whole point, so it gets the bare gesture.
//   SHIFT-drag         pan. The same modifier the plan view uses for "a different verb".
//   wheel              zoom, about the cursor, so you zoom into what you are looking at
//   ESC                deselect
//
// Orbit and drag both redraw on every mouse move, which is why the projection runs in the
// page at all (relicView3d.clientBundle) rather than round-tripping per frame.
//
// THE WRITE IS NOT HERE. A finished drag posts the same `field` message the plan view and
// the inspector post, so all three land on relicModel.setPart and rewrite exactly one line
// of the .amd. One write path, one undo step, one place for the rules about capsules and
// half-extents to live.
'use strict';

const V3 = require('./relicView3d.js');
const Gizmo = require('./relicGizmo.js');
const Nav = require('./relicNav.js');

/** The primitives the page needs - deliberately not the whole record, which carries source
 *  spans and raw fence text the view has no use for and would only bloat the page with. */
function sceneData(rel) {
  return {
    chambers: (rel.chambers || []).map((c) => ({ key: c.key, name: c.name, x: c.x, y: c.y, z: c.z, r: c.r })),
    boxes: (rel.boxes || []).map((b) => ({ key: b.key, name: b.name, x: b.x, y: b.y, z: b.z, hx: b.hx, hy: b.hy, hz: b.hz })),
    solids: (rel.solids || []).map((s) => ({ key: s.key, name: s.name, kind: s.kind, x: s.x, y: s.y, z: s.z, r: s.r })),
    passages: (rel.passages || []).map((p) => ({ from: p.from, to: p.to, radius: p.radius })),
  };
}

/**
 * @param {object} rel  the parsed relic
 * @param {object} cam  {yaw, pitch}
 * @param {object} vb   the initial viewBox {x,y,w,h}
 * @param {string} sel  the key to start selected, if any
 * @returns {string} the page script
 */
function script(rel, cam, vb, sel) {
  return V3.clientBundle() + Gizmo.clientBundle() + Nav.clientBundle()
    + 'const vscode=acquireVsCodeApi();'
    + 'const REL=' + JSON.stringify(sceneData(rel)) + ';'
    + 'const svg=document.getElementById("scene3");'
    + 'const g=document.getElementById("scene3g");'
    + 'let cam={yaw:' + cam.yaw + ',pitch:' + cam.pitch + '};'
    + 'let vb={x:' + vb.x + ',y:' + vb.y + ',w:' + vb.w + ',h:' + vb.h + '};'
    + 'let sel=' + JSON.stringify(sel || null) + ';'
    + 'let orbit=null,pan=null,move=null,size=null;'
    // Every movable part by key. Passages are NOT here on purpose: a passage has no
    // position of its own - it is defined by the two chambers it joins, so moving one
    // would have to mean moving them, which the plan view already does better.
    + 'function partOf(k){if(!k)return null;'
    + 'return REL.chambers.concat(REL.boxes,REL.solids).find(function(p){return p.key===k;})||null;}'
    // Handle length in WORLD units, taken from the current zoom so the gizmo stays the
    // same size on screen however far in you are.
    + 'function gizL(){return vb.w*0.09;}'
    + 'function apply(){svg.setAttribute("viewBox",vb.x+" "+vb.y+" "+vb.w+" "+vb.h);}'
    + 'function draw(){const p=partOf(sel);'
    + 'g.innerHTML=body(REL,cam)+(p?gizmoSvg(p,cam,gizL(),project)'
    + '+sizeSvg(p,cam,project,gizL()):"");'
    + 'const nv=document.getElementById("navg");'
    + 'if(nv)nv.innerHTML=navSvg(cam,project,100);'
    + 'if(p){const n=g.querySelector(\'[data-key="\'+CSS.escape(p.key)+\'"]\');'
    + 'if(n)n.classList.add("sel3");}'
    + 'vscode.postMessage({type:"sel3d",key:sel});}'
    // Report the angle AND the framing: a redraw fires on every keystroke in the document,
    // and snapping back to a default angle mid-edit is worse than not remembering at all.
    + 'function report(){vscode.postMessage({type:"view3d",x:vb.x,y:vb.y,w:vb.w,h:vb.h,'
    + 'yaw:cam.yaw,pitch:cam.pitch});}'
    + 'function fit(){const e=extent(scene(REL,cam));const p=Math.max(e.w,e.h)*0.08;'
    + 'vb={x:e.x-p,y:e.y-p,w:e.w+p*2,h:e.h+p*2};apply();draw();report();}'
    + 'function pt(e){const p=svg.createSVGPoint();p.x=e.clientX;p.y=e.clientY;'
    + 'return p.matrixTransform(svg.getScreenCTM().inverse());}'
    + 'svg.addEventListener("mousedown",function(e){'
    // An axis handle first: it sits on top of the part it belongs to, and grabbing the
    // part instead would make the gizmo unusable at any angle where they overlap.
    // A SIZE handle first, then a MOVE handle, then the part. They overlap at some
    // angles, and the smaller, more specific target has to win or it is unreachable.
    + 'const sz=e.target.closest(".sz");'
    + 'if(sz&&sel){const p=partOf(sel);'
    + 'const hs=sizeHandles(p,cam,project);'
    + 'const h=hs.find(function(x){return x.field===sz.dataset.field;});'
    + 'if(h&&h.draggable){const q=pt(e);'
    + 'size={field:h.field,h:h,x0:q.x,y0:q.y,o:h.o,orig:h.value,p:p,moved:false};'
    + 'e.preventDefault();return;}}'
    + 'const gz=e.target.closest(".gz");'
    + 'if(gz&&sel){const p=partOf(sel);'
    + 'const hs=handles(p,cam,gizL(),project);'
    + 'const h=hs.find(function(x){return x.axis===gz.dataset.axis;});'
    + 'if(h&&h.draggable){const q=pt(e);'
    + 'move={axis:h.axis,h:h,x0:q.x,y0:q.y,ox:p.x,oy:p.y,oz:p.z,L:gizL(),p:p,moved:false};'
    + 'e.preventDefault();return;}}'
    + 'const g2=e.target.closest("[data-key]");'
    + 'if(g2&&!e.shiftKey){sel=g2.dataset.key;draw();e.preventDefault();return;}'
    + 'if(e.shiftKey){pan={x0:e.clientX,y0:e.clientY,vx:vb.x,vy:vb.y};'
    + 'svg.classList.add("panning");}'
    + 'else{sel=null;orbit={x0:e.clientX,y0:e.clientY,yaw:cam.yaw,pitch:cam.pitch};'
    + 'svg.classList.add("orbiting");draw();}e.preventDefault();});'
    // ONE PLACE that ends a gesture, and several things that call it.
    //
    // A drag lives in `move`/`orbit`/`pan` between mousedown and mouseup, so anything that
    // swallows the mouseup leaves it set - and then every later mouse movement keeps
    // dragging with no button held, which is felt as the mouse being captured. That is not
    // hypothetical: finishing a gizmo drag REWRITES the document, and the edit can move
    // focus away from the webview, so the release lands somewhere that is not us.
    + 'function endGesture(){orbit=null;pan=null;move=null;size=null;'
    + 'svg.classList.remove("orbiting");svg.classList.remove("panning");}'
    // The backstop: a mouse moving with NO BUTTON DOWN cannot be a drag, whatever we
    // think we are in the middle of. Cheap, and it recovers on the very next movement
    // rather than needing a click to clear.
    + 'window.addEventListener("mousemove",function(e){'
    + 'if(!e.buttons&&(move||orbit||pan||size)){endGesture();return;}'
    + 'if(size){const q=pt(e);'
    // A radius is measured from the CENTRE, not along an axis - the circle is the sphere
    // exactly, from every angle, so distance is the whole calculation. A half-extent is
    // an axis, so it uses the same projection the move gizmo does.
    + 'let v;'
    + 'if(size.field==="r"){v=Math.hypot(q.x-size.o.x,q.y-size.o.y);}'
    + 'else{v=size.orig+along(size.h,q.x-size.x0,q.y-size.y0)*size.orig;}'
    // A size of zero or less builds a chamber enclosing nothing, which lint reports and
    // the volume refuses. Stop at 1 rather than write a number the file cannot hold.
    + 'v=Math.max(1,Math.round(v));'
    + 'size.p[size.field]=v;size.moved=true;draw();return;}'
    + 'if(move){const q=pt(e);'
    + 'const t=along(move.h,q.x-move.x0,q.y-move.y0);'
    + 'const d=t*move.L;'
    + 'move.p.x=Math.round(move.ox+(move.axis==="x"?d:0));'
    + 'move.p.y=Math.round(move.oy+(move.axis==="y"?d:0));'
    + 'move.p.z=Math.round(move.oz+(move.axis==="z"?d:0));'
    + 'move.moved=true;draw();return;}'
    + 'if(pan){const k=vb.w/svg.clientWidth;'
    + 'vb.x=pan.vx-(e.clientX-pan.x0)*k;vb.y=pan.vy-(e.clientY-pan.y0)*k;apply();return;}'
    + 'if(!orbit)return;'
    + 'cam.yaw=orbit.yaw+(e.clientX-orbit.x0)*0.008;'
    // Pitch is CLAMPED to a hemisphere. Past straight down the scene mirrors and the
    // relic appears to flip, which reads as a bug rather than a rotation.
    + 'cam.pitch=Math.max(-1.5533,Math.min(1.5533,orbit.pitch+(e.clientY-orbit.y0)*0.008));'
    + 'draw();});'
    + 'window.addEventListener("mouseup",function(){'
    // try/finally, because the state MUST come back even if the post throws. Clearing it
    // last was how one failed message could capture the mouse for good.
    + 'try{'
    // Only a drag that MOVED writes. A click that merely grabbed a handle must not put an
    // edit on the undo stack.
    + 'if(move&&move.moved){vscode.postMessage({type:"field",key:move.p.key,'
    + 'patch:{x:move.p.x,y:move.p.y,z:move.p.z}});}'
    + 'if(size&&size.moved){const pa={};pa[size.field]=size.p[size.field];'
    + 'vscode.postMessage({type:"field",key:size.p.key,patch:pa});}'
    + 'if(orbit||pan)report();'
    + '}finally{endGesture();}});'
    // The webview losing focus mid-drag - which an edit can cause by itself - means the
    // mouseup is going to land somewhere else. End the gesture rather than wait for a
    // release that is never coming here.
    + 'window.addEventListener("blur",endGesture);'
    + 'window.addEventListener("mouseleave",endGesture);'
    + 'svg.addEventListener("mouseleave",function(e){if(!e.buttons)endGesture();});'
    + 'window.addEventListener("pointercancel",endGesture);'
    + 'window.addEventListener("keydown",function(e){if(e.key==="Escape")endGesture();});'
    // Zoom about the cursor: the point under the pointer stays put, so you zoom into the
    // chamber you are looking at rather than into the middle of the relic.
    + 'svg.addEventListener("wheel",function(e){e.preventDefault();'
    + 'const w=pt(e);const f=e.deltaY>0?1.12:1/1.12;'
    + 'vb={x:w.x-(w.x-vb.x)*f,y:w.y-(w.y-vb.y)*f,w:vb.w*f,h:vb.h*f};apply();'
    + 'if(sel)draw();report();},{passive:false});'
    + 'window.addEventListener("keydown",function(e){'
    + 'if(e.key==="Escape"&&sel){sel=null;draw();}});'
    // Blender's move: click a ball to look along that axis. `top` is the Y ball here,
    // not the Z ball - Cosmos is Y-up (see relicNav).
    + 'const nvg=document.getElementById("navg");'
    + 'if(nvg)nvg.addEventListener("click",function(e){'
    + 'const b=e.target.closest(".nav");if(!b)return;'
    + 'const v=NAV_VIEWS[b.dataset.view];if(!v)return;'
    + 'cam={yaw:v.yaw,pitch:v.pitch};draw();report();});'
    + 'window.addEventListener("message",function(e){'
    + 'const m=e.data||{};if(m.type!=="view")return;'
    + 'const v=NAV_VIEWS[m.name];if(!v)return;cam={yaw:v.yaw,pitch:v.pitch};draw();report();});'
    + 'document.querySelectorAll(".vw").forEach(function(b){'
    + 'b.addEventListener("click",function(){const v=NAV_VIEWS[b.dataset.view];'
    + 'if(v){cam={yaw:v.yaw,pitch:v.pitch};draw();report();}});});'
    + 'const fb=document.getElementById("fit");if(fb)fb.addEventListener("click",fit);'
    + 'apply();draw();';
}

module.exports = { script, sceneData };
