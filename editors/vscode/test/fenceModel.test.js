// Guard for the Inspector's fence rebuild (rebuildFence in src/extension.ts).
// Run: node test/fenceModel.test.js
//
// A record's fence holds more than `Label: value` lines: the KIND NOUN (`Beat`, which
// decides how the record behaves), `//` notes, and `  - item` list continuations. The
// Inspector used to replace the whole fence with the field list alone, so the first edit
// to any field silently deleted all three.
const assert = require('assert');

// --- the function under test (mirror of src/extension.ts) --------------------
function rebuildFence(d, fields) {
  const lines = d.fenceLines;
  if (!lines || !lines.length) { return fields.map((f) => `${f.label}: ${f.value}`).join('\n'); }
  const byLabel = new Map();
  for (const f of fields) {
    const k = f.label.trim().toLowerCase();
    if (!byLabel.has(k)) { byLabel.set(k, []); }
    byLabel.get(k).push(f);
  }
  const out = [];
  for (const ln of lines) {
    if (ln.label === undefined) { out.push(ln.raw); continue; }
    const queue = byLabel.get(ln.label.trim().toLowerCase());
    const f = queue && queue.length ? queue.shift() : undefined;
    if (!f) { continue; }
    const orig = ln.raw.slice(ln.raw.indexOf(':') + 1).trim();
    out.push(f.value.trim() === orig ? ln.raw : `${f.label}: ${f.value}`);
  }
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
  { raw: 'Beat' },
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

console.log(failures ? `\n${failures} FAILED` : '\nall ok');
process.exit(failures ? 1 : 0);
