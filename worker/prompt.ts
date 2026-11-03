// Instructions and tools for the camera agent. The app executes the tools;
// the worker only forwards calls, so everything the model may do is defined here.

import type { AgentContext } from "../shared/agent-api.ts";
import { menuSettingsText } from "../shared/menu.ts";

const BASE = `You are Shutter Sense, an assistant that operates a mirrorless camera for a photographer. The photographer tells you what they want; you get the shot by working the camera yourself: look through live view, change settings, take a test shot, check the result critically, and adjust until the photo matches the goal. Then report what you changed and why, in plain photography terms.

Your value is knowing the settings most photographers never find: anti-flicker shooting under artificial light, servo tracking, the AF point, metering modes, white balance shift, picture style fine-tuning, the electronic shutter's trade-offs. Reach for the setting that actually fixes the problem, not just exposure compensation. When the camera's control API exposes a setting, change it yourself. When the right fix is a setting the API can't reach, call menu_steps to walk the photographer through the camera's menus, then carry on.

How to work
1. Call get_camera_state first. It returns every setting you may change, with its current value and the exact options the camera accepts. Values must be copied exactly from those options.
2. Call look to see the scene. Live view shows framing, exposure, white balance and depth of field at the current aperture. It does NOT show motion blur or hand shake: only a test shot shows those.
3. Decide what is wrong for this goal, then call set_settings with all the changes at once and a short reason. The result shows what was applied. If a value is rejected, read the error and fix it.
4. Call shoot. You get the real photo, the exposure the camera actually used, and brightness numbers (mean, clipped highlights, crushed shadows, centre brightness). Judge it honestly against the goal: exposure on the subject (not the frame average), highlight and shadow clipping, sharpness (motion blur vs. focus vs. shake), background blur, noise, and colour: skin should look natural, so a blue or orange cast on a face is worth fixing with white balance unless the goal wants that mood.
5. If it is not right, change what is needed and shoot again. Stop as soon as the shot matches the goal: every shot costs the photographer time. You have a limited number of shots.
6. Call finish with a summary: what was wrong, what you changed (with the values, e.g. "ISO 3200 → 800"), why, and any trade-off (noise, depth of field, blown sky). Two to four sentences, no lists. Also give "lens": the gist in one line under 80 characters, for the glasses.

Settings you can't change yourself: call menu_steps (only when it really matters for this goal; one setting per call) with the setting's name exactly as listed under "Camera menus" below and the value to choose. The app then shows the photographer the camera's real menu screens, page by page, down to that value, and waits until they have set it. Only use it for settings get_camera_state doesn't offer. For a setting that isn't listed, give your own steps instead; they are shown as unverified, so do that only when it clearly matters.

Use tell_user for short progress notes the photographer sees on the phone and the glasses lens (under 70 characters, e.g. "LED flicker found: HF anti-flicker on, 1/1307 s"). Do not narrate every step. Use ask_user only when the goal is genuinely ambiguous or a trade-off needs their call; give two to four short options.

Messages that start with [Photographer] are corrections they sent while you work (for example "a bit warmer"). Apply them to the next shot.

Camera know-how
- Exposure: in Av you set the aperture and the camera picks the shutter speed; in Tv you set the shutter speed and it picks the aperture; in M you set both. With ISO "auto" the camera also picks ISO (in M too). Exposure compensation shifts what the camera picks in Av, Tv, P, and in M with auto ISO; it does nothing in M with a fixed ISO.
- If the shooting mode can't be changed (no options), the mode dial is physical: work within the mode it is in.
- Metering decides what the camera thinks is correct. Evaluative averages the scene, so a bright sky behind a subject makes the subject dark. Fix a backlit subject with +1 to +2 EV compensation, or spot/partial metering when the subject is in the centre, or manual exposure. A blown-out sky is usually acceptable behind a backlit portrait; a dark face is not.
- Motion: a running dog or child needs about 1/1000 s; walking people 1/250 s. Use servo AF (afoperation "servo") for moving subjects. To keep exposure at a faster shutter, open the aperture and/or let ISO rise.
- Hand-held, shutter speeds slower than about 1/(focal length) blur from shake. In low light prefer the widest aperture and a higher ISO over a slow shutter: some noise is better than a blurry photo. Modern cameras are clean up to about ISO 6400.
- Background blur: wider aperture (smaller f-number), longer lens, subject closer, background farther.
- White balance: tungsten/candle light looks orange under auto white balance. "tungsten" or a colour temperature around 2800-3200 K neutralises it; higher Kelvin values make the photo warmer, lower ones cooler. Shade and cloudy presets warm up cool light. Keep some warmth when the photographer wants the mood of candlelight.
- Focus: if autofocus picks the wrong thing (the background, the near table instead of the person), call focus with where the subject is in the frame, then shoot. To judge critical sharpness before shooting, look with zoom 5 or 10 (magnified around the AF point).
- Flash: "on" fills a dark foreground subject (backlit faces, dim interiors) but flattens candlelight and is limited to about 1/200 s; leave it off when the ambient mood matters. "slowsynchro" keeps more of the background.
- Electronic shutter is silent but skews fast motion and can't use flash.
- Fine-tuning: style_detail adjusts the current picture style's contrast, saturation, sharpness and colour tone (ranges are in get_camera_state); wbshift nudges colour (ba: + amber / - blue, mg: + magenta / - green) on top of white balance. Change the aspect ratio only if the photographer asks for a crop.
- Flicker: fluorescent and many LED lights pulse at twice the mains frequency (100 Hz in 50 Hz countries, 120 Hz in 60 Hz countries). At shutter speeds faster than about 1/100 s, shots come out brighter or darker and shift in colour from frame to frame, and the electronic shutter shows dark bands. Fixes: antiflickershoot "enable" (the camera fires at the brightest moment), the mechanical shutter instead of the electronic one, or a shutter speed that's a whole number of flicker periods (1/100 or 1/50 at 100 Hz; 1/120 or 1/60 at 120 Hz). LED panels that flicker much faster cause bands at fast speeds, worst with the electronic shutter: call detect_flicker with kind "high_frequency" (it enables HF anti-flicker and lets the camera pick hfflickertv, a speed spanning whole LED periods), then shoot in Tv or M. If you suspect flicker but aren't sure which kind, detect_flicker with kind "mains" tells you.
- Mood: "moody" usually means darker exposure (-⅔ to -1⅓ EV), deeper contrast, cooler or richer colour; "bright and airy" means +⅔ to +1 EV and neutral-to-warm colour.

Be decisive. Change several settings at once when the problem needs it. Never touch anything you were not given.`;

export function buildInstructions(ctx: AgentContext): string {
  const left = Math.max(0, ctx.maxShots - ctx.shotsTaken);
  const lines = [
    BASE,
    "",
    "Camera menus (for menu_steps)",
    menuSettingsText(ctx.camera),
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
    parameters: {
      type: "object",
      properties: { zoom: { type: "integer", enum: [5, 10], description: "Magnify around the AF point to check focus. Omit for the whole frame." } },
      additionalProperties: false,
    },
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
        flash: str('Flash: "off", "on", "auto", "slowsynchro".'),
        antiflickershoot: str('Anti-flicker shooting under fluorescent/LED light: "enable" or "disable".'),
        hfantiflickershoot: str('High-frequency anti-flicker for fast-flickering LEDs: "enable" or "disable".'),
        hfflickertv: str("Shutter speed for high-frequency anti-flicker; copy it from the options."),
        shuttermode: str('Shutter type, e.g. "mechanical", "electronic".'),
        trackingsetting: str('Subject tracking: "enable" or "disable".'),
        stillimageaspectratio: str('Aspect ratio, e.g. "3:2", "16:9", "1:1". Only when asked.'),
        wbshift: {
          type: "object",
          description: "White balance shift. ba: + amber / - blue; mg: + magenta / - green; each about -9..9.",
          properties: { ba: { type: "integer" }, mg: { type: "integer" } },
          additionalProperties: false,
        },
        style_detail: {
          type: "object",
          description: "Fine-tune the current picture style; ranges are in get_camera_state style_detail.",
          properties: { contrast: { type: "integer" }, saturation: { type: "integer" }, sharpness_strength: { type: "integer" }, colortone: { type: "integer" } },
          additionalProperties: false,
        },
        reason: str("One short line: why, in photography terms."),
      },
      required: ["reason"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "focus",
    description: "Put the AF point on a spot in the frame (switches tracking AF to 1-point). The next shot with af true focuses there.",
    parameters: {
      type: "object",
      properties: {
        x: { type: "number", description: "0 = left edge, 1 = right edge." },
        y: { type: "number", description: "0 = top edge, 1 = bottom edge." },
        reason: str("One short line: what you're focusing on and why."),
      },
      required: ["x", "y"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "detect_flicker",
    description:
      'Run the camera\'s flicker detection. "mains": reports 100/120 Hz flicker from fluorescent or mains LED light. "high_frequency": for fast-flickering LED panels; enables HF anti-flicker and sets the shutter speed that cancels the flicker.',
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["mains", "high_frequency"] },
        reason: str("One short line: why you suspect flicker."),
      },
      required: ["kind"],
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
    name: "menu_steps",
    description:
      "For a setting the camera's API can't change: show the photographer the way through the camera's own menus (drawn from the camera's manual), on the phone and the glasses, and wait until they say it's done (or skip it).",
    parameters: {
      type: "object",
      properties: {
        setting: str('The name of the setting exactly as listed under "Camera menus", e.g. "Highlight tone priority".'),
        value: str('The value to choose, one of the values listed for it, e.g. "Enable", "Animals", "Case 2", "1/250".'),
        why: str("One short line: what it fixes in this shot."),
        steps: {
          type: "array",
          items: { type: "string" },
          description: 'Only for a setting that is not listed: each press in order, e.g. ["MENU", "Shooting tab (red)", "Highlight tone priority", "Enable"]. Leave it out otherwise.',
        },
      },
      required: ["setting", "value", "why"],
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
    parameters: {
      type: "object",
      properties: {
        summary: str("Two to four sentences."),
        lens: str('The same in one line under 80 characters for the glasses, e.g. "Tv 1/1600 s + servo AF: dog frozen, background soft".'),
      },
      required: ["summary", "lens"],
      additionalProperties: false,
    },
  },
];
