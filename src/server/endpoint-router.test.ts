import test from "node:test";
import assert from "node:assert/strict";
import { matchHttpPath } from "./endpoint-router";

test("matchHttpPath matches named params", () => {
  const res = matchHttpPath("/users/:id/orders/:orderId", "/users/42/orders/a1");
  assert.equal(res.ok, true);
  assert.deepEqual(res.params, { id: "42", orderId: "a1" });
});

test("matchHttpPath rejects mismatched static segments", () => {
  const res = matchHttpPath("/users/:id", "/projects/1");
  assert.equal(res.ok, false);
});
