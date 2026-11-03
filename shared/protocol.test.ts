import assert from "node:assert/strict";
import { test } from "node:test";
import { shotReply } from "./protocol.ts";

test("a reply to the shot approval is yes, no, or a correction", () => {
  for (const t of ["Shoot", "yes please", "OK", "go ahead", "Take it"]) assert.equal(shotReply(t), true, t);
  for (const t of ["Skip", "no", "Not yet", "wait a second", "don't"]) assert.equal(shotReply(t), false, t);
  for (const t of ["make it warmer first", "focus on the dog", ""]) assert.equal(shotReply(t), null, t);
});
