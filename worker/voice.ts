// Text to speech for the glasses through Wit.ai, Meta's voice service (the
// cloud side of the Voice SDK). The token stays here, like the Muse key; the
// lens only sends the line to say. Answers are cached, since the agent's
// notes repeat ("Shooting 2/5", "Done").

const WIT_SYNTHESIZE = "https://api.wit.ai/synthesize?v=20240304";
/** Longest line spoken; the lens never says more than a sentence or two. */
export const MAX_SPEECH_CHARS = 220;

/** A failure of the voice service, with a message that is safe to show. */
export class VoiceError extends Error {}

/** MP3 of `text` in `voice`, from the edge cache when the same line was said before. */
export async function speak(token: string, voice: string, text: string, ctx: ExecutionContext): Promise<Response> {
  const key = new Request(`https://speech.cache/${encodeURIComponent(voice)}/${await sha256(text)}`);
  const cache = (caches as unknown as { default: Cache }).default;
  const hit = await cache.match(key);
  if (hit) return hit;
  const res = await fetch(WIT_SYNTHESIZE, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify({ q: text, voice }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new VoiceError(`Voice service answered ${res.status}`);
  const audio = new Response(await res.arrayBuffer(), {
    headers: { "content-type": "audio/mpeg", "cache-control": "public, max-age=86400" },
  });
  ctx.waitUntil(cache.put(key, audio.clone()));
  return audio;
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
