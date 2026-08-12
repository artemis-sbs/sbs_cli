// The 3D view's in-page behaviour: orbit, pan, zoom.
//
// Separate from relicView3d (the maths) and relicView (the panel) because it is neither -
// it is the string of JavaScript the webview runs, and keeping it out of the panel's
// template is what stops a quoting mistake here from breaking the plan view too.
//
// THE GESTURES, and why these ones:
//   drag              orbit. The whole point of the view; it gets the bare gesture.
//   SHIFT-drag        pan. Same modifier the plan view uses to mean "a different verb".
//   wheel             zoom, about the cursor, so you zoom into what you are looking at.
//   Fit               frame the relic at the current angle.
//
// Orbit redraws every mouse move, which is why the projection runs in the page at all
// (see relicView3d.clientBundle) rather than round-tripping to the extension per frame.
'use strict';

const V3 = require('./relicView3d.js');

/** The primitives the page needs - deliberately not the whole record, which carries source
 *  spans and raw fence text the view has no use for and would only bloat the page with. */
function sceneData(rel) {
  return {
    chambers: (rel.chambers || []).map((c) => ({ key: c.key, name: c.name, x: c.x, y: c.y, z: c.z, r: c.r })),
    boxes: (rel.boxes || []).map((b) => ({ key: b.key, name: b.name, x: b.x, y: b.y, z: b.z, hx: b.hx, hy: b.hy, hz: b.hz })),
    solids: (rel.solids || []).map((s) => ({ name: s.name, kind: s.kind, x: s.x, y: s.y, z: s.z, r: s.r })),
    passages: (rel.passages || []).map((p) => ({ from: p.from, to: p.to, radius: p.radius })),
  };
}

/**
 * @param {object} rel  the parsed relic
 * @param {object} cam  {yaw, pitch}
 * @param {object} vb   the initial viewBox {x,y,w,h}
 * @returns {string} the page script
 */
function script(rel, cam, vb) {
  const D = JSON.stringify(sceneData(rel));
  return V3.clientBundle()
    + 'const vscode=acquireVsCodeApi();'
    + 'const REL=' + D + ';'
    + 'const svg=document.getElementById("scene3");'
    + 'const g=document.getElementById("scene3g");'
    + 'let cam={yaw:' + cam.yaw + ',pitch:' + cam.pitch + '};'
    + 'let vb={x:' + vb.x + ',y:' + vb.y + ',w:' + vb.w + ',h:' + vb.h + '};'
    + 'let orbit=null,pan=null;'
    + 'function apply(){svg.setAttribute("viewBox",vb.x+" "+vb.y+" "+vb.w+" "+vb.h);}'
    + 'function draw(){g.innerHTML=body(REL,cam);}'
    // Report BOTH, so a redraw - which happens on every keystroke in the document - puts
    // you back where you were looking instead of snapping to a default angle.
    + 'function report(){vscode.postMessage({type:"view3d",x:vb.x,y:vb.y,w:vb.w,h:vb.h,'
    + 'yaw:cam.yaw,pitch:cam.pitch});}'
    + 'function fit(){const e=extent(scene(REL,cam));const p=Math.max(e.w,e.h)*0.08;'
    + 'vb={x:e.x-p,y:e.y-p,w:e.w+p*2,h:e.h+p*2};apply();report();}'
    + 'svg.addEventListener("mousedown",function(e){'
    + 'if(e.shiftKey){pan={x0:e.clientX,y0:e.clientY,vx:vb.x,vy:vb.y};'
    + 'svg.classList.add("panning");}'
    + 'else{orbit={x0:e.clientX,y0:e.clientY,yaw:cam.yaw,pitch:cam.pitch};'
    + 'svg.classList.add("orbiting");}e.preventDefault();});'
    + 'window.addEventListener("mousemove",function(e){'
    + 'if(pan){const k=vb.w/svg.clientWidth;'
    + 'vb.x=pan.vx-(e.clientX-pan.x0)*k;vb.y=pan.vy-(e.clientY-pan.y0)*k;apply();return;}'
    + 'if(!orbit)return;'
    + 'cam.yaw=orbit.yaw+(e.clientX-orbit.x0)*0.008;'
    // Pitch is CLAMPED to a hemisphere. Past straight down the scene mirrors and the
    // relic appears to flip, which reads as a bug rather than a rotation.
    + 'cam.pitch=Math.max(-1.5533,Math.min(1.5533,orbit.pitch+(e.clientY-orbit.y0)*0.008));'
    + 'draw();});'
    + 'window.addEventListener("mouseup",function(){'
    + 'if(orbit||pan)report();orbit=null;pan=null;'
    + 'svg.classList.remove("orbiting");svg.classList.remove("panning");});'
    // Zoom about the cursor: the point under the pointer stays put, so you zoom into the
    // chamber you are looking at rather than into the middle of the relic.
    + 'svg.addEventListener("wheel",function(e){e.preventDefault();'
    + 'const p=svg.createSVGPoint();p.x=e.clientX;p.y=e.clientY;'
    + 'const w=p.matrixTransform(svg.getScreenCTM().inverse());'
    + 'const f=e.deltaY>0?1.12:1/1.12;'
    + 'vb={x:w.x-(w.x-vb.x)*f,y:w.y-(w.y-vb.y)*f,w:vb.w*f,h:vb.h*f};apply();report();},'
    + '{passive:false});'
    + 'const fb=document.getElementById("fit");if(fb)fb.addEventListener("click",fit);'
    + 'apply();draw();';
}

module.exports = { script, sceneData };
