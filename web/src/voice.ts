// Push-to-talk capture: records mono PCM, encodes 16-bit 24 kHz WAV, and sends
// it to the worker, which transcribes it with Muse Voice Transcribe.

const TARGET_RATE = 24000;
const MAX_SECONDS = 45;

export class Recorder {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private chunks: Float32Array[] = [];
  private node: ScriptProcessorNode | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  recording = false;

  static supported() {
    return !!navigator.mediaDevices?.getUserMedia && typeof AudioContext !== "undefined";
  }

  async start(onAutoStop: () => void) {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    let src: MediaStreamAudioSourceNode;
    try {
      this.ctx = new AudioContext();
      src = this.ctx.createMediaStreamSource(this.stream);
      // ScriptProcessor is deprecated but universally available and plenty for push-to-talk.
      this.node = this.ctx.createScriptProcessor(4096, 1, 1);
    } catch (e) {
      // Don't leave the microphone on.
      this.stream.getTracks().forEach((t) => t.stop());
      void this.ctx?.close();
      this.ctx = null;
      throw e;
    }
    this.chunks = [];
    this.node.onaudioprocess = (e) => this.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    src.connect(this.node);
    this.node.connect(this.ctx.destination);
    this.recording = true;
    this.timer = setTimeout(onAutoStop, MAX_SECONDS * 1000);
  }

  async stop(): Promise<Blob | null> {
    if (!this.recording || !this.ctx) return null;
    this.recording = false;
    if (this.timer) clearTimeout(this.timer);
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    const rate = this.ctx.sampleRate;
    await this.ctx.close();
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    if (total < rate * 0.3) return null; // under 300 ms: an accidental tap
    const all = new Float32Array(total);
    let o = 0;
    for (const c of this.chunks) {
      all.set(c, o);
      o += c.length;
    }
    return encodeWav(resample(all, rate, TARGET_RATE), TARGET_RATE);
  }
}

function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    // Average the source samples that fall into this output sample (cheap low-pass).
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    out[i] = end > start ? sum / (end - start) : (input[start] ?? 0);
  }
  return out;
}

function encodeWav(samples: Float32Array, rate: number): Blob {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}

export async function transcribeBlob(wav: Blob): Promise<string> {
  const res = await fetch("/api/transcribe", {
    method: "POST",
    headers: { "content-type": "audio/wav" },
    body: wav,
  });
  const data = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
  if (!res.ok) throw new Error(data.error ?? "Transcription failed");
  return data.text ?? "";
}
