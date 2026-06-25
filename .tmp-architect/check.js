const fs = require("fs");
const av = require("../.pipeline/lib/architect-verify.js");
const handoff = require("../.pipeline/lib/handoff.js");
const body = fs.readFileSync(".tmp-architect/body.txt", "utf8");
const signoff = fs.readFileSync(".tmp-architect/signoff.txt", "utf8");
const diff = fs.readFileSync(".tmp-architect/diff.txt", "utf8");

const recipe = av.parseSignoffRecipe(body, signoff);
console.log("signed_commit:", recipe ? recipe.signed_commit : null);
const expected = recipe.expected_files;
console.log("--- EXPECTED (recipe) ---");
for (const e of expected) console.log("  -", e.path, e.range || "");
const chunks = av.parsePrDiff(diff);
const touched = chunks.map((c) => c.file_path);
console.log("--- TOUCHED (diff) ---");
for (const t of touched) console.log("  *", t);
console.log("--- EXPECTED NOT TOUCHED ---");
for (const e of expected) {
  const hit = touched.some((t) => t && (t === e.path || t.endsWith(e.path) || e.path.endsWith(t)));
  if (!hit) console.log("  ! MISSING:", e.path);
}
console.log("--- TOUCHED NOT IN RECIPE ---");
for (const t of touched) {
  if (!t) { console.log("  ? null-path chunk"); continue; }
  const hit = expected.some((e) => t === e.path || t.endsWith(e.path) || e.path.endsWith(t));
  if (!hit) console.log("  + EXTRA:", t);
}
let inj = false;
for (const c of chunks) {
  const r = handoff.detectInjection(c.raw);
  if (r.hits && r.hits.length) { inj = true; console.log("  INJECTION in", c.file_path, "->", r.hits[0]); }
}
console.log("INJECTION:", inj);
