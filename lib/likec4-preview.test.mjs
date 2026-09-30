import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { computeLikeC4Preview, clearLikeC4PreviewCache } = await jiti.import("./likec4-preview.ts");

function validSource(n) {
  return [
    "specification {",
    `  element kind${n}`,
    "  element other",
    "}",
    "model {",
    `  a = kind${n} 'A'`,
    "  b = other 'B'",
    "  a -> b 'rel'",
    "}",
    "views {",
    "  view index {",
    "    title 'Index'",
    "    include *",
    "  }",
    "}",
  ].join("\n");
}

test("computes layouted views for a valid source", async () => {
  const { views, diagnostics, partial } = await computeLikeC4Preview(validSource(1));

  assert.equal(diagnostics.length, 0);
  assert.equal(partial, false);
  assert.ok(views.length >= 1);
  const view = views[0];
  assert.equal(view.id, "index");
  assert.equal(view.title, "Index");
  // Layouted by graphviz: nodes carry absolute positions.
  assert.ok(view.nodes.length >= 2, "view should include both elements");
  for (const node of view.nodes) {
    assert.equal(typeof node.x, "number");
    assert.equal(typeof node.y, "number");
  }
});

test("broken sources report diagnostics instead of throwing", async () => {
  const { views, diagnostics, partial } = await computeLikeC4Preview("model { broken {");

  assert.ok(diagnostics.length > 0);
  for (const diagnostic of diagnostics) {
    assert.ok(typeof diagnostic.message === "string" && diagnostic.message.length > 0);
    assert.equal(typeof diagnostic.line, "number");
    assert.ok(diagnostic.severity === "error" || diagnostic.severity === "warning");
  }
  // Views computed from a broken model are, at best, partial.
  assert.equal(partial, views.length > 0 && diagnostics.length > 0);
});

test("identical content joins the same cached computation", async () => {
  clearLikeC4PreviewCache();
  const source = validSource(2);
  const first = computeLikeC4Preview(source);
  const second = computeLikeC4Preview(source);
  assert.equal(second, first, "same content must share one in-flight promise");
  await first;
  const third = computeLikeC4Preview(source);
  assert.equal(third, first, "completed results stay cached");
});

test("different content computes separately and the cache evicts LRU", async () => {
  clearLikeC4PreviewCache();
  const head = computeLikeC4Preview(validSource(3));
  // Fill the cache beyond capacity so `head` becomes the eviction victim.
  for (let i = 0; i < 16; i++) {
    await computeLikeC4Preview(validSource(100 + i));
  }
  const revived = computeLikeC4Preview(validSource(3));
  assert.notEqual(revived, head, "evicted entries must recompute");
  await revived;
});
