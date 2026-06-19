import { test } from "node:test";
import assert from "node:assert/strict";
import { maskValue, maskErrorString } from "./pii-mask";

const data = {
  customer_email: "ahmet@example.com",
  amount: 5000,
  active: true,
  items: [{ sku: "A1", qty: 2 }],
  nested: { deep: { token: "secret123" } },
  missing: null,
};

test("full → unchanged", () => {
  assert.deepEqual(maskValue(data, "full"), data);
});

test("shape → structure + types preserved, values redacted, null kept", () => {
  const m = maskValue(data, "shape") as Record<string, unknown>;
  assert.equal(m.customer_email, "«string:17»");
  assert.equal(m.amount, "«int»");
  assert.equal(m.active, "«boolean»");
  assert.deepEqual(m.items, [{ sku: "«string:2»", qty: "«int»" }]); // array recursed, length kept
  assert.deepEqual(m.nested, { deep: { token: "«string:9»" } }); // nested keys kept
  assert.equal(m.missing, null); // null distinguishable from missing
  // no raw PII anywhere
  assert.equal(JSON.stringify(m).includes("ahmet"), false);
  assert.equal(JSON.stringify(m).includes("secret123"), false);
});

test("shape: diagnosis-useful — double-wrap + null visible", () => {
  const wrapped = { payload: { payload: { email: null } } };
  const m = maskValue(wrapped, "shape");
  assert.deepEqual(m, { payload: { payload: { email: null } } }); // AI sees the double-nest
});

test("keys → keys + bare types, arrays collapsed", () => {
  const m = maskValue(data, "keys") as Record<string, unknown>;
  assert.equal(m.customer_email, "«string»"); // no length
  assert.equal(m.items, "«array:1»"); // collapsed, not recursed
  assert.deepEqual(m.nested, { deep: { token: "«string»" } });
  assert.equal(JSON.stringify(m).includes("ahmet"), false);
});

test("scalars + arrays at top level", () => {
  assert.equal(maskValue("secret", "shape"), "«string:6»");
  assert.equal(maskValue(42, "shape"), "«int»");
  assert.deepEqual(maskValue([1, "x"], "shape"), ["«int»", "«string:1»"]);
});

test("error string redaction", () => {
  assert.equal(
    maskErrorString("invalid email ahmet@x.com (id 123456)", "shape"),
    "invalid email «email» (id «num»)",
  );
  // short numbers (HTTP status codes) are kept — diagnostically useful, not PII
  assert.equal(maskErrorString("Notion 401 unauthorized", "shape"), "Notion 401 unauthorized");
  assert.equal(maskErrorString("boom", "full"), "boom");
  assert.equal(maskErrorString(undefined, "shape"), undefined);
});
