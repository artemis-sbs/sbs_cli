// POST a command to a running `sbs debug` mock session, and - when asked - bring back
// what the runner actually said.
//
// It lives here beside the other plain-node modules, with no `vscode` import, so it can
// be tested against a throwaway http server. That matters more than usual: this file is
// where a failed command used to become a silent success.
//
// The session's stdlib server answers POST /debug/command. WITHOUT `wait` it queues the
// command and replies `{"ok":true}` on the spot, because the runner's real answer travels
// the /debug websocket, which an HTTP caller is not on. WITH `wait` the server tags the
// command, matches the reply off its frame pump, and returns it as the body.
'use strict';

const http = require('http');

/**
 * @param {number} port      the session's port (`amd.sessionPort`, default 8765)
 * @param {object} body      the command, e.g. {action:'relic_reload', key:'ossuary'}
 * @param {object} [opts]    {wait: true} to get the runner's reply; {timeoutMs}
 * @returns {Promise<object>} the parsed reply
 * @throws  rejects with the RUNNER'S OWN message when the reply carries `error`
 */
function postDebugCommand(port, body, opts) {
  const wait = !!(opts && opts.wait);
  // Comfortably past the server's own 1.5s wait, so a slow-but-answering session reports
  // its answer rather than our impatience.
  const timeoutMs = (opts && opts.timeoutMs) || (wait ? 4000 : 2000);
  const payload = wait ? Object.assign({}, body, { wait: true }) : body;
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(payload), 'utf8');
    const req = http.request(
      {
        host: '127.0.0.1', port, path: '/debug/command', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
        timeout: timeoutMs,
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          if (!res.statusCode || res.statusCode >= 300) {
            reject(new Error('HTTP ' + res.statusCode));
            return;
          }
          let reply = {};
          try { reply = JSON.parse(raw) || {}; } catch (e) { reply = {}; }
          // The runner's own words beat anything we could invent here. This is the whole
          // reason the reply is fetched at all.
          if (reply && reply.error) { reject(new Error(String(reply.error))); return; }
          resolve(reply);
        });
      });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.write(data); req.end();
  });
}

/** How to describe a reply in the status bar. Falls back when the session is older than
 *  this extension and simply queued the command without answering. */
function describeReply(reply, fallback) {
  if (reply && reply.ack) { return String(reply.ack); }
  if (reply && reply.pending) { return fallback + ' (session busy - still working)'; }
  return fallback;
}

/**
 * What kind of failure a reload hit, so the caller can give the right advice.
 *
 *   'no-session'  nothing answered on the port - startable
 *   'no-relic'    a session answered, but no relic is built yet: it is sitting at the
 *                 map picker, or on a map that does not build one. The fix is to pick
 *                 the map, NOT to restart anything.
 *   'refused'     the session answered and said no for its own reason - a key that does
 *                 not exist, a radius of zero. Its words are better than ours.
 *
 * The middle case is the one worth separating: it is the normal state of a session that
 * was just started, and reporting it as an error would send an author restarting a
 * session that is working perfectly well.
 */
function classifyReloadFailure(message) {
  const why = String(message || '');
  if (/timeout|ECONNREFUSED|ECONNRESET|socket|EHOSTUNREACH/i.test(why)) { return 'no-session'; }
  if (/no relic was loaded|has not built one/i.test(why)) { return 'no-relic'; }
  return 'refused';
}

module.exports = { postDebugCommand, describeReply, classifyReloadFailure };
