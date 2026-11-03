// Thin client for the Meta Model API (Muse models).

import type { AgentResponse, FunctionCall } from "../shared/agent-api.ts";

const BASE = "https://api.meta.ai/v1";

export const MODELS = {
  agent: "muse-wonder-1.0",
  transcribe: "muse-voice-transcribe-1.0",
  image: "muse-image-1.0",
};

/** An API failure with a message that is safe to show the user. */
export class MuseError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
  }
}

/** fetch, with a timeout and failures turned into MuseErrors. */
async function call(url: string, init: RequestInit, timeoutMs: number, what: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    if (e instanceof Error && e.name === "TimeoutError") throw new MuseError(`${what} timed out`, 504);
    throw e;
  }
  if (res.ok) return res;
  let detail = "";
  // An auth failure's message can quote part of the key: it stays in the logs, not the answer.
  if (res.status === 401 || res.status === 403) console.error(`${what}: HTTP ${res.status}`, await res.text().catch(() => ""));
  else {
    try {
      const body = await res.json<{ error?: { message?: string } }>();
      detail = body?.error?.message ?? "";
    } catch {
      // body was not JSON
    }
  }
  throw new MuseError(`${what} failed (${res.status})${detail ? `: ${detail}` : ""}`, res.status === 429 ? 429 : 502);
}

export async function createResponse(apiKey: string, body: Record<string, unknown>): Promise<AgentResponse> {
  const res = await call(
    `${BASE}/responses`,
    { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body) },
    90_000,
    "Agent call",
  );
  const data = await res.json<{
    output?: Array<{ type: string; phase?: string; content?: Array<{ type: string; text?: string }> } & Partial<FunctionCall>>;
  }>();
  const calls: FunctionCall[] = [];
  let text = "";
  let commentary = "";
  for (const item of data.output ?? []) {
    if (item.type === "function_call") {
      if (!item.call_id || !item.name) continue;
      calls.push({ type: "function_call", call_id: item.call_id, name: item.name, arguments: item.arguments ?? "{}" });
    } else if (item.type === "message") {
      let t = "";
      for (const c of item.content ?? []) if (c.type === "output_text" && c.text) t += c.text;
      if (item.phase === "commentary") commentary += t;
      else text += t;
    }
  }
  return { calls, text: text.trim(), commentary: commentary.trim() };
}

/** The picture in an images API answer as a data URL (JPEG as asked; WebP or PNG if the model ignored that). */
async function imageResult(res: Response): Promise<string> {
  const data = await res.json<{ data?: Array<{ b64_json?: string | null; url?: string | null }> }>();
  const first = data.data?.[0];
  let b64 = first?.b64_json ?? "";
  if (!b64 && first?.url?.startsWith("https://")) {
    const img = await call(first.url, {}, 30_000, "Picture download");
    const bytes = new Uint8Array(await img.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    b64 = btoa(bin);
  }
  if (!b64) throw new MuseError("The image model returned no picture");
  // The file's first bytes in base64: FF D8 (JPEG), "RIFF" (WebP), else PNG.
  const type = b64.startsWith("/9j/") ? "jpeg" : b64.startsWith("UklGR") ? "webp" : "png";
  return `data:image/${type};base64,${b64}`;
}

/** A new picture from a prompt (images API). */
export async function generateImage(apiKey: string, model: string, prompt: string): Promise<string> {
  const res = await call(
    `${BASE}/images/generations`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt, n: 1, response_format: "b64_json", output_format: "jpeg" }),
    },
    90_000,
    "Picture",
  );
  return imageResult(res);
}

/** A JPEG changed as the prompt says (images API, edits). */
export async function editImage(apiKey: string, model: string, jpeg: Uint8Array, prompt: string): Promise<string> {
  const form = new FormData();
  form.append("model", model);
  form.append("prompt", prompt);
  form.append("n", "1");
  form.append("response_format", "b64_json");
  form.append("output_format", "jpeg");
  form.append("image", new Blob([jpeg], { type: "image/jpeg" }), "frame.jpg");
  const res = await call(`${BASE}/images/edits`, { method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: form }, 90_000, "Picture");
  return imageResult(res);
}

export async function transcribe(apiKey: string, wav: ArrayBuffer): Promise<string> {
  const form = new FormData();
  form.append(
    "request",
    new Blob([JSON.stringify({ model: MODELS.transcribe, audioEncoding: "WAV", mode: "PUSH_TO_TALK" })], {
      type: "application/json",
    }),
  );
  form.append("audio", new Blob([wav], { type: "audio/wav" }), "speech.wav");
  const res = await call(
    `${BASE}/asr/transcribe`,
    { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" }, body: form },
    60_000,
    "Transcription",
  );
  const data = await res.json<{ transcript?: string }>();
  return (data.transcript ?? "").trim();
}
