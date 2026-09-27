"""The browser panel `sbs osc web` serves - one HTML page, kept as a string so it ships
inside sbs.pyz. The helm first, mirroring the TouchOSC helm layout.

Every control sends its OSC address as JSON over the WebSocket and FOLLOWS the same
address coming back, so a lever moved at the real helm moves here too. While a control is
being dragged, incoming values for it are ignored for a moment so it does not fight the
finger.
"""

PAGE = r"""<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
<title>Helm panel</title>
<style>
  :root { --bg:#0d0f14; --panel:#171b24; --fg:#e6e8ee; --dim:#8a91a0;
          --green:#35d07f; --red:#ff4d4d; --blue:#4d9cff; --gold:#ffcc33; }
  * { box-sizing:border-box; }
  body { margin:0; padding:16px; background:var(--bg); color:var(--fg);
         font:15px system-ui, sans-serif; touch-action:manipulation; }
  header { display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; }
  #status { color:var(--dim); font-size:13px; }
  #status.ok { color:var(--green); }
  .grid { display:grid; grid-template-columns: 110px 110px 1fr 200px; gap:14px; }
  .col { display:flex; flex-direction:column; gap:10px; }
  .panel { background:var(--panel); border-radius:10px; padding:12px; }
  h2 { margin:0 0 8px; font-size:12px; letter-spacing:.08em; color:var(--dim); }
  button { width:100%; min-height:64px; border:0; border-radius:8px; font-size:15px;
           font-weight:600; color:var(--fg); background:#2a3040; cursor:pointer; }
  button.on.red { background:var(--red); } button.on.blue { background:var(--blue); }
  button.on.gold { background:var(--gold); color:#222; }
  button.warp.on { background:var(--blue); }
  .impulse { height:420px; display:flex; justify-content:center; }
  .impulse input { writing-mode: vertical-lr; direction: rtl; width:64px; height:100%; }
  input[type=range] { accent-color: var(--green); }
  .row { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
  .gauge { margin-bottom:12px; }
  .gauge .bar { height:18px; background:#2a3040; border-radius:4px; overflow:hidden; }
  .gauge .fill { height:100%; width:0; background:var(--blue); transition: width .15s; }
  .gauge .val { float:right; color:var(--dim); }
  #heading { width:100%; }
  @media (max-width: 760px) { .grid { grid-template-columns: 1fr 1fr; } }
</style></head>
<body>
<header><strong>HELM</strong><span id="status">connecting...</span></header>
<div class="grid">
  <div class="col panel">
    <h2>IMPULSE</h2>
    <div class="impulse"><input id="impulse" type="range" min="0" max="1" step="0.01" value="0"></div>
    <button id="reverse" class="gold" data-toggle="/helm/reverse">REV</button>
  </div>
  <div class="col panel">
    <h2>WARP</h2>
    <button class="warp" data-warp="4">WARP 4</button>
    <button class="warp" data-warp="3">WARP 3</button>
    <button class="warp" data-warp="2">WARP 2</button>
    <button class="warp" data-warp="1">WARP 1</button>
    <button class="warp" data-warp="0">OFF</button>
  </div>
  <div class="col">
    <div class="panel row">
      <button id="red_alert" class="red" data-toggle="/helm/red_alert">RED ALERT</button>
      <button id="shields" class="blue" data-toggle="/helm/shields">SHIELDS</button>
    </div>
    <div class="panel row">
      <button data-press="/helm/stop">ALL STOP</button>
      <div class="row"><button data-press="/helm/dock">DOCK</button>
                       <button data-press="/helm/undock">UNDOCK</button></div>
    </div>
    <div class="panel">
      <h2>HEADING <span id="heading_val" style="float:right">0</span></h2>
      <input id="heading" type="range" min="0" max="359" step="1" value="0">
    </div>
  </div>
  <div class="panel">
    <h2>SHIP</h2>
    <div class="gauge"><span>Front shield</span><span class="val" id="g_front_v"></span>
      <div class="bar"><div class="fill" id="g_front"></div></div></div>
    <div class="gauge"><span>Rear shield</span><span class="val" id="g_rear_v"></span>
      <div class="bar"><div class="fill" id="g_rear"></div></div></div>
    <div class="gauge"><span>Energy</span><span class="val" id="g_energy_v"></span>
      <div class="bar"><div class="fill" id="g_energy" style="background:var(--gold)"></div></div></div>
    <div class="gauge"><span>Warp</span><span class="val" id="g_warp_v"></span>
      <div class="bar"><div class="fill" id="g_warp"></div></div></div>
    <div class="gauge"><span>Weapons target</span><span class="val" id="g_target"></span></div>
  </div>
</div>
<script>
const params = new URLSearchParams(location.search);
const ship = params.get("ship") || "1";
let ws, held = {};                       // address -> time a finger last moved it
function send(a, v) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({a: a, v: [v]}));
}
function hold(a) { held[a] = Date.now(); }
function isHeld(a) { return held[a] && Date.now() - held[a] < 600; }

const impulse = document.getElementById("impulse");
impulse.addEventListener("input", () => { hold("/helm/impulse"); send("/helm/impulse", parseFloat(impulse.value)); });
const heading = document.getElementById("heading");
heading.addEventListener("input", () => {
  document.getElementById("heading_val").textContent = heading.value;
  send("/helm/heading", parseFloat(heading.value));
});
document.querySelectorAll("[data-toggle]").forEach(b => b.addEventListener("click", () => {
  const on = !b.classList.contains("on");
  b.classList.toggle("on", on); hold(b.dataset.toggle);
  send(b.dataset.toggle, on ? 1 : 0);
}));
document.querySelectorAll("[data-press]").forEach(b =>
  b.addEventListener("click", () => send(b.dataset.press, 1)));
document.querySelectorAll("[data-warp]").forEach(b =>
  b.addEventListener("click", () => send("/helm/warp/" + b.dataset.warp, 1)));

function gauge(id, value, max, text) {
  const pct = Math.max(0, Math.min(1, value / max)) * 100;
  document.getElementById(id).style.width = pct + "%";
  document.getElementById(id + "_v").textContent = text;
}
function apply(a, v) {
  const x = v[0];
  if (isHeld(a)) return;
  switch (a) {
    case "/helm/impulse": impulse.value = x; break;
    case "/helm/reverse": document.getElementById("reverse").classList.toggle("on", !!x); break;
    case "/helm/red_alert": document.getElementById("red_alert").classList.toggle("on", !!x); break;
    case "/helm/shields": document.getElementById("shields").classList.toggle("on", !!x); break;
    case "/state/shields/front": gauge("g_front", x, 1, Math.round(x * 100) + "%"); break;
    case "/state/shields/rear": gauge("g_rear", x, 1, Math.round(x * 100) + "%"); break;
    case "/state/energy": gauge("g_energy", x, 1000, Math.round(x)); break;
    case "/state/warp":
      gauge("g_warp", x, 4, x ? "WARP " + x : "impulse");
      document.querySelectorAll("[data-warp]").forEach(b =>
        b.classList.toggle("on", parseInt(b.dataset.warp) === x && x > 0));
      break;
    case "/state/target/weapons": document.getElementById("g_target").textContent = x || "-"; break;
  }
}
function connect() {
  const st = document.getElementById("status");
  ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws?ship=" + ship);
  ws.onopen = () => { st.textContent = "connected - ship " + ship; st.className = "ok"; };
  ws.onmessage = (e) => { try { const m = JSON.parse(e.data); apply(m.a, m.v); } catch (err) {} };
  ws.onclose = () => { st.textContent = "reconnecting..."; st.className = ""; setTimeout(connect, 1000); };
}
connect();
</script>
</body></html>
"""
