// Guard for the Inspector's fence rebuild (rebuildFence in src/extension.ts).
// Run: node test/fenceModel.test.js
//
// A record's fence holds more than `Label: value` lines: the KIND NOUN (`Beat`, which
// decides how the record behaves), `//` notes, and `  - item` list continuations. The
// Inspector used to replace the whole fence with the field list alone, so the first edit
// to any field silently deleted all three.
const assert = require('assert');

// --- the function under test (mirror of src/extension.ts) --------------------
function rebuildFence(d, fields, kind) {
  const lines = d.fenceLines;
  const wantKind = kind === undefined ? undefined : kind.trim();
  if (!lines || !lines.length) {
    const only = fields.map((f) => `${f.label}: ${f.value}`).join('\n');
    return wantKind ? `${wantKind}\n${only}` : only;
  }
  const byLabel = new Map();
  for (const f of fields) {
    const k = f.label.trim().toLowerCase();
    if (!byLabel.has(k)) { byLabel.set(k, []); }
    byLabel.get(k).push(f);
  }
  const out = [];
  let kindWritten = false;
  for (const ln of lines) {
    if (ln.kind) {
      if (wantKind === undefined) { out.push(ln.raw); }
      else if (wantKind) { out.push(wantKind); }
      kindWritten = true;
      continue;
    }
    if (ln.label === undefined) { out.push(ln.raw); continue; }
    const queue = byLabel.get(ln.label.trim().toLowerCase());
    const f = queue && queue.length ? queue.shift() : undefined;
    if (!f) { continue; }
    const orig = ln.raw.slice(ln.raw.indexOf(':') + 1).trim();
    out.push(f.value.trim() === orig ? ln.raw : `${f.label}: ${f.value}`);
  }
  if (!kindWritten && wantKind) { out.unshift(wantKind); }
  const kept = new Set(lines.filter((l) => l.label !== undefined)
                            .map((l) => l.label.trim().toLowerCase()));
  for (const f of fields) {
    if (!kept.has(f.label.trim().toLowerCase())) { out.push(`${f.label}: ${f.value}`); }
  }
  return out.join('\n');
}

let failures = 0;
function check(name, cond) {
  if (cond) { console.log('  ok  - ' + name); }
  else { console.log('  FAIL- ' + name); failures++; }
}

// The fence an author actually wrote.
const detail = { fenceLines: [
  { raw: 'Beat', kind: true },
  { raw: '// re-time this once the ramscoop lands' },
  { raw: 'Roles:', label: 'Roles' },
  { raw: '  - advisor' },
  { raw: 'Starts when: signal ramscoop_online', label: 'Starts when' },
] };
const fields = [
  { label: 'Roles', value: '' },
  { label: 'Starts when', value: 'signal ramscoop_online' },
];

// 1) An untouched round trip is byte-identical.
check('round trip is byte-stable',
  rebuildFence(detail, fields) === detail.fenceLines.map((l) => l.raw).join('\n'));

// 2) Editing one field keeps the kind noun, the note and the list item.
const edited = rebuildFence(detail, [
  { label: 'Roles', value: '' },
  { label: 'Starts when', value: 'revealed' },
]);
check('kind noun survives an edit', edited.split('\n')[0] === 'Beat');
check('comment survives an edit', edited.includes('// re-time this once the ramscoop lands'));
check('list continuation survives an edit', edited.includes('  - advisor'));
check('the edit applied', edited.includes('Starts when: revealed'));

// 3) A field the author removed drops out; the rest stays put.
const removed = rebuildFence(detail, [{ label: 'Starts when', value: 'revealed' }]);
check('removed field drops out', !removed.includes('Roles:'));
check('...without taking the kind noun with it', removed.split('\n')[0] === 'Beat');

// 4) A new field is appended, once.
const added = rebuildFence(detail, fields.concat([{ label: 'Reward', value: '200 credits' }]));
check('new field appended', added.trim().endsWith('Reward: 200 credits'));
check('new field appears once', added.split('Reward:').length === 2);

// 5) No fenceLines (an older server) -> the old behaviour, not a crash.
check('degrades to the field list', rebuildFence({}, fields) === 'Roles: \nStarts when: signal ramscoop_online');


// 6) The kind picker: change, clear, add, and leave alone.
const changed = rebuildFence(detail, fields, 'Cue');
check('picking a different noun rewrites the kind line', changed.split('\n')[0] === 'Cue');
check('...and touches nothing else', changed.includes('// re-time this once the ramscoop lands'));

const cleared = rebuildFence(detail, fields, '');
check('clearing the noun drops the line', !cleared.startsWith('Cue') && !cleared.startsWith('Beat'));
check('...leaving the rest intact', cleared.split('\n')[0] === '// re-time this once the ramscoop lands');

const bare = { fenceLines: [{ raw: 'Reward: 200 credits', label: 'Reward' }] };
const named = rebuildFence(bare, [{ label: 'Reward', value: '200 credits' }], 'Job');
check('a record with no noun gets one, FIRST', named === 'Job\nReward: 200 credits');

check('an older webview (no kind sent) leaves the noun alone',
  rebuildFence(detail, fields, undefined).split('\n')[0] === 'Beat');

console.log(failures ? `\n${failures} FAILED` : '\nall ok');
process.exit(failures ? 1 : 0);
