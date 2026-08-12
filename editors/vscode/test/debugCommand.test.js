// The transport that made a failed command look successful.
//
// postDebugCommand used to call res.resume() and throw the body away, so a runner reply
// of {"error": "no story is running yet"} resolved as a success and the status bar said
// so. Against a throwaway http server these assert the four answers a session can give.
'use strict';

const http = require('http');
const assert = require('assert');
const { postDebugCommand, describeReply, classifyReloadFailure } = require('../media/debugCommand.js');

let pass = 0, fail = 0;
function check(name, ok) {
  if (ok) { pass++; console.log('  ok  - ' + name); }
  else { fail++; console.log('  FAIL- ' + name); }
}

// A stand-in session: replies with whatever the test hands it, and records what it got.
function session(reply, status) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try { seen.push(JSON.parse(raw)); } catch (e) { seen.push(null); }
      if (reply === null) { return; }                 // never answers: the timeout case
      res.writeHead(status || 200, { 'Content-Type': 'application/json' });
      res.end(typeof reply === 'string' ? reply : JSON.stringify(reply));
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({ srv, seen, port: srv.address().port }));
  });
}

async function main() {
  console.log('\ndebugCommand\n');

  {
    const s = await session({ ack: 'rebuilt ossuary: 8 chambers, 7 passages' });
    const reply = await postDebugCommand(s.port, { action: 'relic_reload' }, { wait: true });
    check('an ack comes back parsed', reply.ack.indexOf('8 chambers') >= 0);
    check('...and `wait` is asked for on the wire', s.seen[0].wait === true);
    check('...carrying the command itself', s.seen[0].action === 'relic_reload');
    s.srv.close();
  }

  {
    // THE regression. This used to resolve, and the caller cheerfully reported success.
    const s = await session({ error: 'relic_reload: no relic was loaded from a file' });
    let msg = null;
    try { await postDebugCommand(s.port, { action: 'relic_reload' }, { wait: true }); }
    catch (e) { msg = e.message; }
    check('an error REJECTS instead of passing as success', msg !== null);
    check("...with the runner's own words, not ours",
      msg === 'relic_reload: no relic was loaded from a file');
    s.srv.close();
  }

  {
    const s = await session({ ok: true }, 500);
    let threw = false;
    try { await postDebugCommand(s.port, { action: 'status' }); } catch (e) { threw = true; }
    check('a non-2xx rejects', threw);
    s.srv.close();
  }

  {
    const s = await session(null);                     // accepts, never answers
    let threw = false;
    try { await postDebugCommand(s.port, { action: 'status' }, { timeoutMs: 120 }); }
    catch (e) { threw = true; }
    check('a session that never answers rejects rather than hanging', threw);
    s.srv.close();
  }

  {
    // An older session that predates the wait protocol: it queues and says ok. That is
    // not an error - the command may well have worked - so it must not reject.
    const s = await session({ ok: true });
    const reply = await postDebugCommand(s.port, { action: 'relic_reload' }, { wait: true });
    check('a legacy {ok:true} still resolves', reply.ok === true);
    check('...and describes itself with the fallback',
      describeReply(reply, 'reload sent') === 'reload sent');
    s.srv.close();
  }

  {
    const s = await session('not json at all');
    const reply = await postDebugCommand(s.port, { action: 'status' });
    check('a non-JSON body is tolerated, not thrown', typeof reply === 'object');
    s.srv.close();
  }

  check('describeReply prefers the ack', describeReply({ ack: 'rebuilt' }, 'sent') === 'rebuilt');
  check('describeReply says so when the session is still working',
    describeReply({ pending: true }, 'sent').indexOf('still working') >= 0);

  // --- what KIND of failure, so the advice fits -------------------------------
  const C = classifyReloadFailure;
  check('nothing listening is a startable session',
    C('connect ECONNREFUSED 127.0.0.1:8765') === 'no-session' && C('timeout') === 'no-session');
  // The normal state of a session that has just been started: it is at the map picker.
  // Calling this an error sends an author restarting something that works.
  check('a session with no relic yet is not a broken session',
    C('relic reload: no relic was loaded from a file') === 'no-relic'
    && C("relic reload: no relic named 'ossuary' - this mission has not built one") === 'no-relic');
  check('a wrong key is the session refusing, not a missing map',
    C("relic reload: no relic named 'nope' (loaded: ossuary)") === 'refused');
  check('a bad edit is the session refusing too',
    C("relic reload failed: volume 'ossuary': solid sphere radius must be positive") === 'refused');

  console.log('\n' + (fail ? fail + ' FAILED' : 'all debugCommand tests passed') + '\n');
  process.exit(fail ? 1 : 0);
}

main();
