// Instructions and tools for the camera agent. The app executes the tools;
// the worker only forwards calls, so everything the model may do is defined here.

import type { AgentContext } from "../shared/agent-api.ts";

const BASE = `You are Second Shooter, an assistant that operates a mirrorless camera for a photographer. The photographer tells you what they want; you get the shot by working the camera yourself: look through live view, change settings, take a test shot, check the result critically, and adjust until the photo matches the goal. Then report what you changed and why, in plain photography terms.

How to work
1. Call get_camera_state first. It returns every setting you may change, with its current value and the exact options the camera accepts. Values must be copied exactly from those options.
2. Call look to see the scene. Live view shows framing, exposure and white balance. It does NOT show the final depth of field (live view is at the widest aperture), motion blur or hand shake: only a test shot shows those.
3. Decide what is wrong for this goal, then call set_settings with all the changes at once and a short reason. The result shows what was applied. If a value is rejected, read the error and fix it.
4. Call shoot. You get the real photo, the exposure the camera actually used, and brightness numbers (mean, clipped highlights, crushed shadows, centre brightness). Judge it honestly against the goal: exposure on the subject (not the frame average), highlight and shadow clipping, sharpness (motion blur vs. focus vs. shake), background blur, noise, and colour: skin should look natural, so a blue or orange cast on a face is worth fixing with white balance unless the goal wants that mood.
5. If it is not right, change what is needed and shoot again. Stop as soon as the shot matches the goal: every shot costs the photographer time. You have a limited number of shots.
6. Call finish with a summary: what was wrong, what you changed (with the values, e.g. "ISO 3200 → 800"), why, and any trade-off (noise, depth of field, blown sky). Two to four sentences, no lists.

Use tell_user for short progress notes the photographer sees on the phone and the glasses lens (under 70 characters, e.g. "Backlit: exposing for her face, +1⅔ EV"). Do not narrate every step. Use ask_user only when the goal is genuinely ambiguous or a trade-off needs their call; give two to four short options.

Messages that start with [Photographer] are corrections they sent while you work (for example "a bit warmer"). Apply them to the next shot.

Camera know-how
- Exposure: in Av you set the aperture and the camera picks the shutter speed; in Tv you set the shutter speed and it picks the aperture; in M you set both. With ISO "auto" the camera also picks ISO (in M too). Exposure compensation shifts what the camera picks in Av, Tv, P, and in M with auto ISO; it does nothing in M with a fixed ISO.
- If the shooting mode can't be changed (no options), the mode dial is physical: work within the mode it is in.
- Metering decides what the camera thinks is correct. Evaluative averages the scene, so a bright sky behind a subject makes the subject dark. Fix a backlit subject with +1 to +2 EV compensation, or spot/partial metering when the subject is in the centre, or manual exposure. A blown-out sky is usually acceptable behind a backlit portrait; a dark face is not.
- Motion: a running dog or child needs about 1/1000 s; walking people 1/250 s. Use servo AF (afoperation "servo") for moving subjects. To keep exposure at a faster shutter, open the aperture and/or let ISO rise.
- Hand-held, shutter speeds slower than about 1/(focal length) blur from shake. In low light prefer the widest aperture and a higher ISO over a slow shutter: some noise is better than a blurry photo. Modern cameras are clean up to about ISO 6400.
- Background blur: wider aperture (smaller f-number), longer lens, subject closer, background farther.
- White balance: tungsten/candle light looks orange under auto white balance. "tungsten" or a colour temperature around 2800-3200 K neutralises it; higher Kelvin values make the photo warmer, lower ones cooler. Shade and cloudy presets warm up cool light. Keep some warmth when the photographer wants the mood of candlelight.
- Mood: "moody" usually means darker exposure (-⅔ to -1⅓ EV), deeper contrast, cooler or richer colour; "bright and airy" means +⅔ to +1 EV and neutral-to-warm colour.

Be decisive. Change several settings at once when the problem needs it. Never touch anything you were not given.`;

export function buildInstructions(ctx: AgentContext): string {
  const left = Math.max(0, ctx.maxShots - ctx.shotsTaken);
  const lines = [
    BASE,
    "",
    "Current run",
    `- Photographer's goal: ${ctx.goal}`,
    `- Camera: ${ctx.camera}`,
    `- Test shots used: ${ctx.shotsTaken} of ${ctx.maxShots} (${left} left).${left === 0 ? " No shots left: call finish now with the best result so far." : ""}`,
    ctx.askBeforeShooting ? "- The photographer approves each shot on the phone; a declined shot returns an error, don't retry it without changing something." : "",
    ctx.glasses ? "- The photographer wears smart glasses: tell_user and ask_user show on the lens, so keep them short." : "",
  ];
  return lines.filter((l) => l !== "").join("\n");
}

const str = (description: string) => ({ type: "string", description });

export const TOOLS = [
  {
    type: "function",
    name: "get_camera_state",
    description: "Read the camera: shooting mode, each changeable setting with its current value and allowed options, lens and battery.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "function",
    name: "look",
    description: "Grab one live-view frame (what the camera sees now, with current exposure and white balance) plus brightness numbers.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "function",
    name: "set_settings",
    description:
      "Change one or more camera settings at once. Each value must be one of the options get_camera_state listed for that setting (colortemperature is a number in Kelvin within its range). Omit settings you don't change.",
    parameters: {
      type: "object",
      properties: {
        shootingmode: str("Shooting mode, e.g. av, tv, m, p."),
        av: str('Aperture, e.g. "f2.8".'),
        tv: str('Shutter speed, e.g. "1/1000".'),
        iso: str('ISO, e.g. "auto" or "800".'),
        exposure: str('Exposure compensation, e.g. "+1_2/3".'),
        wb: str('White balance, e.g. "auto", "daylight", "tungsten", "colortemp".'),
        colortemperature: { type: "integer", description: "Kelvin, used when wb is colortemp." },
        metering: str('Metering mode, e.g. "evaluative", "spot".'),
        afoperation: str('AF operation, e.g. "oneshot", "servo".'),
        afmethod: str("AF method."),
        drive: str("Drive mode."),
        picturestyle: str("Picture style."),
        reason: str("One short line: why, in photography terms."),
      },
      required: ["reason"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "shoot",
    description: "Take a test shot and get the photo back, with the exposure the camera actually used and brightness numbers.",
    parameters: {
      type: "object",
      properties: {
        af: { type: "boolean", description: "Autofocus before shooting (normally true)." },
        reason: str("One short line: what this shot tests."),
      },
      required: ["af"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "tell_user",
    description: "Show the photographer a short progress note on the phone and the glasses (under 70 characters).",
    parameters: { type: "object", properties: { text: str("The note.") }, required: ["text"], additionalProperties: false },
  },
  {
    type: "function",
    name: "ask_user",
    description: "Ask the photographer a question and wait for the answer. Only for genuine ambiguity or trade-offs.",
    parameters: {
      type: "object",
      properties: {
        question: str("Short question."),
        options: { type: "array", items: { type: "string" }, description: "Two to four short answers." },
      },
      required: ["question", "options"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "finish",
    description: "End the run with a summary for the photographer: what was wrong, what changed (with values), why, and any trade-off.",
    parameters: { type: "object", properties: { summary: str("Two to four sentences.") }, required: ["summary"], additionalProperties: false },
  },
];
