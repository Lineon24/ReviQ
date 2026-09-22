import { test } from "node:test";
import assert from "node:assert/strict";
import { sameOrigin, safeEqual, sessionToken } from "../lib/auth";

test("session signing and same-origin checks protect the Node session endpoint", () => {
  assert.equal(sameOrigin(new Request("http://0.0.0.0:3000/api/session", { headers: { Host: "localhost:3000", Origin: "http://localhost:3000" } })), true);
  assert.equal(sameOrigin(new Request("http://localhost:3000/api/session", { headers: { Origin: "https://other.example" } })), false);
  assert.equal(safeEqual("same", "same"), true);
  assert.equal(safeEqual("same", "different"), false);
  assert.match(sessionToken(), /^\d+\.[a-f0-9]{64}$/);
});
