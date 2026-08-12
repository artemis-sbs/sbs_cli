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

/** JSON safe to embed INSIDE a <script> tag.
 *
 *  JSON.stringify does not escape `<`, and a chamber named `x</script><b>` therefore ends
 *  the script element and starts writing markup - the relic file is data from wherever the
 *  mission came from, so that is an injection, not a typo. Escaping the angle bracket as
 *  a unicode escape keeps the JSON identical to the parser and inert to the HTML one.
 *  U+2028/9 are line terminators to JavaScript but not to JSON, so they go too.
 */
function embed(value) {
  return JSON.stringify(value)
    .split('<').join('\\u003c')
    .split('\u2028').join('\\u2028')
    .split('\u2029').join('\\u2029');
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
    + 'const REL=' + embed(sceneData(rel)) + ';'
    + 'const svg=document.getElementById("scene3");'
    + 'const g=document.getElementById("scene3g");'
    + 'let cam={yaw:' + cam.yaw + ',pitch:' + cam.pitch + '};'
    + 'let vb={x:' + vb.x + ',y:' + vb.y + ',w:' + vb.w + ',h:' + vb.h + '};'
    + 'let sel=' + embed(sel || null) + ';'
    + 'let orbit=null,pan=null,move=null,size=null,link=null;'
    // Every movable part by key. Passages are NOT here on purpose: a passage has no
    // position of its own - it is defined by the two chambers it joins, so moving one
    // would have to mean moving them, which the plan view already does better.
    + 'function partOf(k){if(!k)return null;'
    + 'return REL.chambers.concat(REL.boxes,REL.solids).find(function(p){return p.key===k;})||null;}'
    // Handle length in WORLD units, taken from the current zoom so the gizmo stays the
    // same size on screen however far in you are.
    + 'function gizL(){return vb.w*0.09;}'
    // What the view turns AROUND. The selection if there is one - you orbit to see the
    // thing you are working on from another side, and turning about the world origin
    // instead swings it out of frame just as you get close to it. With nothing selected,
    // the middle of the relic, which is still better than a corner of it.
    + 'function pivot(){const p=partOf(sel);if(p)return p;'
    + 'const all=REL.chambers.concat(REL.boxes);'
    + 'if(!all.length)return{x:0,y:0,z:0};'
    + 'let x=0,y=0,z=0;all.forEach(function(q){x+=q.x;y+=q.y;z+=q.z;});'
    + 'return{x:x/all.length,y:y/all.length,z:z/all.length};}'
    // A viewBox with a NaN in it is IGNORED by the browser, which shows as the view
    // snapping to some other framing - indistinguishable from a zoom, and impossible to
    // trace back to the arithmetic that produced it. Refuse it at the one place it is
    // written.
    + 'function apply(){if(!isFinite(vb.x)||!isFinite(vb.y)||!isFinite(vb.w)||!isFinite(vb.h)'
    + '||vb.w<=0||vb.h<=0)return;'
    + 'svg.setAttribute("viewBox",vb.x+" "+vb.y+" "+vb.w+" "+vb.h);}'
    + 'function draw(){const p=partOf(sel);'
    + 'g.innerHTML=body(REL,cam)+(p?gizmoSvg(p,cam,gizL(),project)'
    + '+sizeSvg(p,cam,project,gizL()):"");'
    // innerHTML into a STABLE wrapper. `outerHTML` on an SVG element parses its string as
    // HTML, so the new nodes land in the HTML namespace and never render - the grid simply
    // disappears after the first redraw.
    + 'const gr=document.getElementById("grid3g");'
    + 'if(gr)gr.innerHTML=gridSvg(REL,cam,Math.max(vb.w,vb.h),vb.w);'
    // The labels are part of the PICTURE, so they have to be redrawn with it. Rendering
    // them once server-side left the names sitting where the chambers used to be, which
    // reads as the scene sliding out from under its own labels.
    + 'const lb=document.getElementById("lab3g");'
    + 'if(lb)lb.innerHTML=labelSvg(scene(REL,cam),Math.max(vb.w,vb.h)/42);'
    + 'const nv=document.getElementById("navg");'
    + 'if(nv)nv.innerHTML=navSvg(cam,project,100);'
    + 'if(p){const n=g.querySelector(\'[data-key="\'+CSS.escape(p.key)+\'"]\');'
    + 'if(n)n.classList.add("sel3");}'
    + 'showInsp();vscode.postMessage({type:"sel3d",key:sel});}'
    // Report the angle AND the framing: a redraw fires on every keystroke in the document,
    // and snapping back to a default angle mid-edit is worse than not remembering at all.
    + 'function report(){vscode.postMessage({type:"view3d",x:vb.x,y:vb.y,w:vb.w,h:vb.h,'
    + 'yaw:cam.yaw,pitch:cam.pitch});}'
    + 'function fit(){const e=extent(scene(REL,cam));const p=Math.max(e.w,e.h)*0.08;'
    + 'vb={x:e.x-p,y:e.y-p,w:e.w+p*2,h:e.h+p*2};apply();draw();report();}'
    + 'function pt(e){const p=svg.createSVGPoint();p.x=e.clientX;p.y=e.clientY;'
    + 'return p.matrixTransform(svg.getScreenCTM().inverse());}'
    // MIDDLE-CLICK AUTOSCROLL has to be refused at the DOCUMENT, in the capture phase.
    // Preventing it on the scene's own mousedown is both too late and too narrow: the
    // press can land on a child element, and by the time it bubbles the browser has
    // already armed its scroll mode - which then reads every drag as a scroll and every
    // scroll as a zoom, so orbit and pan simply never start.
    + 'document.addEventListener("mousedown",function(e){'
    + 'if(e.button===1)e.preventDefault();},true);'
    + 'document.addEventListener("auxclick",function(e){'
    + 'if(e.button===1)e.preventDefault();},true);'
    + 'svg.addEventListener("mousedown",function(e){'
    // MIDDLE BUTTON NAVIGATES, Blender's convention: middle drags orbit, SHIFT-middle
    // pans, the wheel zooms. It is worth copying for more than familiarity - it leaves
    // the LEFT button entirely to the work (select, move, size, connect), which is the
    // only way those can all coexist without a modifier each.
    //
    // preventDefault stops the browser's middle-click autoscroll, which would otherwise
    // hijack the very gesture we are binding.
    + 'if(e.button===1){e.preventDefault();'
    + 'if(e.shiftKey){pan={x0:e.clientX,y0:e.clientY,vx:vb.x,vy:vb.y};'
    + 'svg.classList.add("panning");}'
    + 'else{orbit={x0:e.clientX,y0:e.clientY,yaw:cam.yaw,pitch:cam.pitch,'
    + 'p:pivot(),s:null,moved:true};orbit.s=project(orbit.p,cam);'
    + 'svg.classList.add("orbiting");}return;}'
    + 'if(e.button!==0)return;'
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
    // SHIFT turns a drag from "select this" into "connect these" - the same gesture and
    // the same modifier the plan view uses, so the reflex carries over unchanged.
    + 'if(g2&&e.shiftKey){link={from:g2.dataset.key};svg.classList.add("linking");'
    + 'e.preventDefault();return;}'
    + 'if(g2){sel=g2.dataset.key;draw();e.preventDefault();return;}'
    + 'if(e.shiftKey){pan={x0:e.clientX,y0:e.clientY,vx:vb.x,vy:vb.y};'
    + 'svg.classList.add("panning");}'
    // Starting an orbit KEEPS the selection. You orbit in order to look at the selected
    // thing from another side, so throwing it away is the opposite of what was asked for.
    // A click on empty space that does NOT turn into a drag still deselects - that is
    // handled on mouseup, where a click and a drag can be told apart.
    + 'else{orbit={x0:e.clientX,y0:e.clientY,yaw:cam.yaw,pitch:cam.pitch,'
    + 'p:pivot(),s:null,moved:false};'
    + 'orbit.s=project(orbit.p,cam);'
    + 'svg.classList.add("orbiting");}e.preventDefault();});'
    // ONE PLACE that ends a gesture, and several things that call it.
    //
    // A drag lives in `move`/`orbit`/`pan` between mousedown and mouseup, so anything that
    // swallows the mouseup leaves it set - and then every later mouse movement keeps
    // dragging with no button held, which is felt as the mouse being captured. That is not
    // hypothetical: finishing a gizmo drag REWRITES the document, and the edit can move
    // focus away from the webview, so the release lands somewhere that is not us.
    + 'function endGesture(){orbit=null;pan=null;move=null;size=null;link=null;'
    + 'svg.classList.remove("linking");'
    + 'svg.classList.remove("orbiting");svg.classList.remove("panning");}'
    // The backstop: a mouse moving with NO BUTTON DOWN cannot be a drag, whatever we
    // think we are in the middle of. Cheap, and it recovers on the very next movement
    // rather than needing a click to clear.
    + 'window.addEventListener("mousemove",function(e){'
    + 'if(!e.buttons&&(move||orbit||pan||size||link)){endGesture();return;}'
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
    + 'orbit.moved=true;'
    // Hold the pivot still on screen. The projection itself turns about the world origin,
    // so after each camera change the pivot has moved; shifting the viewBox by exactly
    // that much puts it back, and the result is a view that turns around the pivot rather
    // than one that swings it away.
    + 'const a=project(orbit.p,cam);'
    + 'vb=holdPivot(vb,orbit.s,a);orbit.s=a;apply();'
    + 'draw();});'
    + 'window.addEventListener("mouseup",function(ev){'
    // try/finally, because the state MUST come back even if the post throws. Clearing it
    // last was how one failed message could capture the mouse for good.
    + 'try{'
    // Only a drag that MOVED writes. A click that merely grabbed a handle must not put an
    // edit on the undo stack.
    + 'if(move&&move.moved){vscode.postMessage({type:"field",key:move.p.key,'
    + 'patch:{x:move.p.x,y:move.p.y,z:move.p.z}});}'
    + 'if(size&&size.moved){const pa={};pa[size.field]=size.p[size.field];'
    + 'vscode.postMessage({type:"field",key:size.p.key,patch:pa});}'
    // A press on empty space that never turned into a drag is a CLICK, and a click on
    // nothing means deselect. Told apart here rather than at mousedown, because at
    // mousedown the two are still the same event.
    + 'if(link){const t=ev&&ev.target&&ev.target.closest?ev.target.closest("[data-key]"):null;'
    // Only chambers and boxes can be joined; a solid is subtracted space, not a room. The
    // page cannot tell them apart from the element alone, so it asks the scene data.
    + 'if(t&&t.dataset.key!==link.from&&!REL.solids.some(function(s){return s.key===t.dataset.key;}))'
    + 'vscode.postMessage({type:"link",from:link.from,to:t.dataset.key});}'
    + 'if(orbit&&!orbit.moved&&sel){sel=null;draw();}'
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
    // A WHEEL DURING A DRAG IS NEVER A ZOOM. Whatever produced it - a browser that armed
    // autoscroll before we refused it, a tilt wheel, a trackpad - the author has a button
    // held and is orbiting. Zooming underneath that is what made a middle-drag "go wonky
    // and zoom in" the moment the direction changed.
    + 'svg.addEventListener("wheel",function(e){e.preventDefault();'
    + 'if(orbit||pan||move||size||link)return;'
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
    // Clicking the axis already facing you flips to the far side - see relicNav.
    + 'const v=NAV_VIEWS[nextView(b.dataset.view,cam)];if(!v)return;'
    + 'cam={yaw:v.yaw,pitch:v.pitch};draw();report();});'
    + 'window.addEventListener("message",function(e){'
    + 'const m=e.data||{};if(m.type!=="view")return;'
    + 'const v=NAV_VIEWS[m.name];if(!v)return;cam={yaw:v.yaw,pitch:v.pitch};draw();report();});'
    // THE INSPECTOR. Dragging is not a substitute for typing: an author who wants a
    // radius of exactly 900 should not have to land it with a mouse. Same form the plan
    // view used, same `field` message out, so a typed number and a dragged one are the
    // same one-line write.
    + 'const IN={x:"fx",y:"fy",z:"fz",r:"fr",hx:"fhx",hy:"fhy",hz:"fhz"};'
    + 'function el(id){return document.getElementById(id);}'
    + 'function showInsp(){const p=partOf(sel);const ins=el("insp");if(!ins)return;'
    + 'if(!p){ins.classList.add("hidden");return;}'
    + 'ins.classList.remove("hidden");'
    + 'el("iname").textContent=p.name||p.key;'
    + 'const isBox=p.hx!==undefined;'
    + 'const isSolid=REL.solids.some(function(s){return s.key===p.key;});'
    + 'el("ikind").textContent=isBox?"box":(isSolid?"solid":"chamber");'
    + 'Object.keys(IN).forEach(function(k){const n=el(IN[k]);if(!n)return;'
    + 'n.value=(p[k]===undefined||p[k]===null)?"":p[k];});'
    + 'const lr=el("lr");if(lr)lr.classList.toggle("hidden",p.r===undefined);'
    + '["lhx","lhy","lhz"].forEach(function(id){const n=el(id);'
    + 'if(n)n.classList.toggle("hidden",!isBox);});}'
    + 'Object.keys(IN).forEach(function(k){const n=el(IN[k]);if(!n)return;'
    + 'n.addEventListener("change",function(){const p=partOf(sel);if(!p)return;'
    + 'const v=Number(n.value);if(!isFinite(v))return;'
    // A size of zero builds a chamber enclosing nothing, which lint reports and the
    // volume refuses - so the form will not send one either.
    + 'const val=(k==="x"||k==="y"||k==="z")?Math.round(v):Math.max(1,Math.round(v));'
    + 'p[k]=val;const pa={};pa[k]=val;'
    + 'vscode.postMessage({type:"field",key:p.key,patch:pa});draw();});});'
    + 'const ab=document.getElementById("add");'
    // A new chamber lands at the middle of the view, on the floor the view is pivoting
    // around - "where I am looking" needs a height as well as a place, and the pivot's
    // is the only one the author has expressed an opinion about.
    + 'if(ab)ab.addEventListener("click",function(){'
    + 'const w=unproject(vb.x+vb.w/2,vb.y+vb.h/2,cam,Math.round(pivot().y));'
    + 'vscode.postMessage({type:"add",x:Math.round(w.x),y:Math.round(w.y),'
    + 'z:Math.round(w.z)});});'
    + 'const db=document.getElementById("del");'
    + 'if(db)db.addEventListener("click",function(){'
    + 'if(sel)vscode.postMessage({type:"remove",key:sel});});'
    + 'window.addEventListener("keydown",function(e){'
    + 'if(e.target&&e.target.tagName==="INPUT")return;'
    + 'if((e.key==="Delete"||e.key==="Backspace")&&sel){e.preventDefault();'
    + 'vscode.postMessage({type:"remove",key:sel});}});'
    // RIGHT CLICK OPENS A MENU. The left button is busy with select/move/size/connect and
    // the middle navigates, so the right is the only one left - and it is the one that
    // can carry "here": the click point unprojects to an exact spot on the floor, which
    // is a better Add than a toolbar button that can only mean "the middle of the view".
    + 'const ctx=document.getElementById("ctx");'
    + 'function hideCtx(){if(ctx)ctx.classList.add("hidden");}'
    + 'function item(label,fn){const d=document.createElement("div");d.textContent=label;'
    + 'd.addEventListener("click",function(){hideCtx();fn();});ctx.appendChild(d);}'
    + 'svg.addEventListener("contextmenu",function(e){if(!ctx)return;e.preventDefault();'
    + 'const g2=e.target.closest("[data-key]");'
    + 'const q=pt(e);const w=unproject(q.x,q.y,cam,Math.round(pivot().y));'
    + 'ctx.innerHTML="";'
    + 'if(g2){const k=g2.dataset.key;'
    + 'item("Select "+k,function(){sel=k;draw();});'
    + 'item("Frame it",function(){sel=k;const p=partOf(k);'
    + 'if(p){const s0=project(p,cam);const r=(p.r||p.hx||600)*4;'
    + 'vb={x:s0.x-r,y:s0.y-r,w:r*2,h:r*2};apply();draw();report();}});'
    + 'item("Delete "+k,function(){vscode.postMessage({type:"remove",key:k});});'
    + 'ctx.appendChild(document.createElement("hr"));}'
    + 'item("Add chamber here",function(){vscode.postMessage({type:"add",'
    + 'x:Math.round(w.x),y:Math.round(w.y),z:Math.round(w.z)});});'
    + 'item("Frame all",fit);'
    + 'const b=svg.getBoundingClientRect();'
    + 'ctx.style.left=(e.clientX-b.left)+"px";ctx.style.top=(e.clientY-b.top)+"px";'
    + 'ctx.classList.remove("hidden");});'
    + 'window.addEventListener("mousedown",function(e){'
    + 'if(ctx&&!ctx.contains(e.target))hideCtx();},true);'
    + 'window.addEventListener("keydown",function(e){if(e.key==="Escape")hideCtx();});'
    + 'document.querySelectorAll(".vw").forEach(function(b){'
    + 'b.addEventListener("click",function(){const v=NAV_VIEWS[b.dataset.view];'
    + 'if(v){cam={yaw:v.yaw,pitch:v.pitch};draw();report();}});});'
    + 'const fb=document.getElementById("fit");if(fb)fb.addEventListener("click",fit);'
    + 'apply();draw();';
}

module.exports = { script, sceneData, embed };
