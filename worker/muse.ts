// Thin client for the Meta Model API (Muse models).

const BASE = "https://api.meta.ai/v1";

export const MODELS = {
  agent: "muse-wonder-1.0",
  transcribe: "muse-voice-transcribe-1.0",
};

export interface FunctionCall { type: "function_call"; call_id: string; name: string; arguments: string }

export interface ResponseResult {
  calls: FunctionCall[];
  text: string;
  commentary: string;
}

/** An API failure with a message that is safe to show the user. */
export class MuseError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
  }
}

async function check(res: Response, what: string): Promise<void> {
  if (res.ok) return;
  let detail = "";
  try {
    const body = await res.json<{ error?: { message?: string } }>();
    detail = body?.error?.message ?? "";
  } catch {
    // body was not JSON
  }
  throw new MuseError(`${what} failed (${res.status})${detail ? `: ${detail}` : ""}`, res.status === 429 ? 429 : 502);
}

export async function createResponse(apiKey: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<ResponseResult> {
  const timeout = AbortSignal.timeout(90_000);
  const res = await fetch(`${BASE}/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  await check(res, "Agent call");
  const data = await res.json<{
    output?: Array<{ type: string; phase?: string; content?: Array<{ type: string; text?: string }> } & Partial<FunctionCall>>;
  }>();
  const calls: FunctionCall[] = [];
  let text = "";
  let commentary = "";
  for (const item of data.output ?? []) {
    if (item.type === "function_call") {
      calls.push({ type: "function_call", call_id: item.call_id!, name: item.name!, arguments: item.arguments ?? "{}" });
    } else if (item.type === "message") {
      let t = "";
      for (const c of item.content ?? []) if (c.type === "output_text" && c.text) t += c.text;
      if (item.phase === "commentary") commentary += t;
      else text += t;
    }
  }
  return { calls, text: text.trim(), commentary: commentary.trim() };
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
  const res = await fetch(`${BASE}/asr/transcribe`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  await check(res, "Transcription");
  const data = await res.json<{ transcript?: string }>();
  return (data.transcript ?? "").trim();
}
