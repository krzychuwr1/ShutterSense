import assert from "node:assert/strict";
import { test } from "node:test";
import { withRecentImages } from "./loop.ts";

const img = (i: number) => ({ type: "function_call_output", call_id: `c${i}`, output: [{ type: "input_text", text: `shot ${i}` }, { type: "input_image", image_url: "data:image/jpeg;base64,AA" }] });

test("only the latest three images stay attached", () => {
  const input = [{ role: "user", content: [{ type: "input_text", text: "Goal" }] }, img(1), img(2), img(3), img(4)];
  const out = withRecentImages(input);
  const images = out.flatMap((i) => (Array.isArray((i as { output?: unknown }).output) ? ((i as { output: Array<{ type: string }> }).output) : [])).filter((p) => p.type === "input_image");
  assert.equal(images.length, 3);
  assert.deepEqual((out[1] as { output: unknown[] }).output[1], { type: "input_text", text: "[older image removed]" });
  assert.equal(img(1).output[1].type, "input_image");
  assert.equal((input[1] as ReturnType<typeof img>).output[1].type, "input_image", "the original transcript is not modified");
});
