import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";
import type { ToolContext } from "./context.js";
import type { JobRunner } from "./jobs.js";
import { log } from "./log.js";
import type { Media } from "./media.js";
import { errorResult, textResult, ToolError } from "./results.js";

export interface Services {
  media: Media;
  jobs: JobRunner;
}

export interface ToolSettings {
  outputDir: string;
  waitSeconds: number;
}

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;
type Work = (ctx: ToolContext, services: Services) => Promise<CallToolResult>;

const EN_VOICES = [
  "amalthea", "andromeda", "apollo", "arcas", "aries", "asteria", "athena", "atlas", "aurora", "callista",
  "cora", "cordelia", "delia", "draco", "electra", "harmonia", "helena", "hera", "hermes", "hyperion",
  "iris", "janus", "juno", "jupiter", "luna", "mars", "minerva", "neptune", "odysseus", "ophelia",
  "orion", "orpheus", "pandora", "phoebe", "pluto", "saturn", "thalia", "theia", "vesta", "zeus",
] as const;
const ES_VOICES = ["sirio", "nestor", "carina", "celeste", "alvaro", "diana", "aquila", "selena", "estrella", "javier"] as const;
const SHORT_STYLES = ["cinematic", "photoreal", "anime", "3d-cartoon", "watercolor", "comic", "dark-documentary", "oil-painting"] as const;
const MUSIC_MOODS = ["auto", "none", "lofi", "chill", "upbeat", "cinematic", "dramatic", "dark", "energetic", "inspiring"] as const;
const PRESETS = ["bold", "karaoke", "minimal"] as const;

const color = z.string().regex(/^(#?[0-9a-fA-F]{3}|#?[0-9a-fA-F]{6}|[a-zA-Z]+)$/, "use a hex color like #FFE14D or a color name");
const fileName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "use a bare filename like in.mp4");
const quality = z.enum(["draft", "standard", "high"]).optional().describe("draft renders fastest, high looks best. Default standard.");

export function registerTools(server: McpServer, services: () => Services, settings: ToolSettings): void {
  const tool = (extra: Extra, work: Work) => guard(extra, services, work);
  const saved = `Saves the result under ${settings.outputDir} and returns absolute paths, public URLs, duration and usage.`;
  const slow = `If it's still running after ${settings.waitSeconds} s you get a job_id: call get_job to keep waiting.`;
  const opHints = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

  server.registerTool(
    "add_captions",
    {
      title: "Add captions",
      description: `Burn animated word-by-word captions (TikTok/Reels style) into a video, in the cloud: no local ffmpeg or whisper needed. Transcribes the speech and also returns .srt, .vtt and .ass subtitles plus a word-timed transcript. The video can be a local path (uploaded automatically, max 100 MB) or a public URL. ${saved} Usually 15-60 s. ${slow}`,
      inputSchema: {
        video: z.string().min(1).describe("Video with speech: local path or http(s) URL."),
        preset: z
          .enum(PRESETS)
          .optional()
          .describe("bold (default): 3 big uppercase words mid-screen, spoken word in yellow. karaoke: 5 words at the bottom, cyan highlight. minimal: up to 7 smaller words at the bottom, no highlight."),
        font: z.enum(["Montserrat", "Anton", "Bebas Neue", "Poppins"]).optional().describe("Overrides the preset font."),
        position: z.enum(["top", "middle", "bottom"]).optional().describe("Overrides the preset position."),
        max_words: z.number().int().min(1).max(8).optional().describe("Words per caption, 1-8."),
        uppercase: z.boolean().optional(),
        text_color: color.optional().describe("Hex like #FFFFFF or a color name."),
        highlight_color: color.optional().describe("Color of the word being spoken."),
        outline_color: color.optional(),
        size: z.number().min(0.5).max(2).optional().describe("Text size multiplier, 1 = preset size."),
        language: z
          .string()
          .regex(/^[a-zA-Z]{2,3}([-_][a-zA-Z0-9]{2,8})?$/)
          .optional()
          .describe("Spoken language code like en, es or pt-BR. Omit to auto-detect."),
        quality,
      },
      annotations: opHints,
    },
    async ({ video, preset, font, position, max_words, uppercase, text_color, highlight_color, outline_color, size, language, quality }, extra) =>
      tool(extra, async (ctx, { media, jobs }) => {
        const custom = compact({ font, position, max_words, uppercase, text_color, highlight_color, outline_color, size });
        const style = Object.keys(custom).length > 0 ? compact({ preset, ...custom }) : preset;
        const videoUrl = await media.toUrl(video, ctx);
        return jobs.start("captions", compact({ video_url: videoUrl, style, language, quality }), `${stemOf(video)}-captioned`, ctx);
      }),
  );

  server.registerTool(
    "make_slideshow",
    {
      title: "Make slideshow",
      description: `Turn images into an mp4 slideshow, in the cloud: transitions, Ken Burns motion, optional voiceover (text-to-speech or a recording), background music ducked under the voice, and burned-in captions of the narration. Use it instead of stitching images with local ffmpeg. Images and audio can be local paths (uploaded automatically) or public URLs. Each image shows 3 s by default; with a voiceover the images stretch to fit it. ${saved} Usually 15-90 s. ${slow}`,
      inputSchema: {
        images: z.array(z.string().min(1)).min(1).max(100).describe("Images in display order: local paths or http(s) URLs."),
        seconds_per_image: z.number().min(0.5).max(60).optional().describe("Seconds each image stays up. Default 3, or fit to the voiceover."),
        duration_s: z.number().positive().max(900).optional().describe("Total length in seconds, split evenly across the images. Alternative to seconds_per_image."),
        size: z.string().optional().describe("9:16 (default, 1080x1920), 16:9, 1:1, 4:5, 3:4, 4:3 or WIDTHxHEIGHT."),
        transition: z
          .string()
          .optional()
          .describe("fade (default), dissolve, slideleft, slideup, wipeleft, circleopen, zoomin, pixelize, radial, random, none, or any ffmpeg xfade name."),
        transition_s: z.number().min(0.1).max(2).optional().describe("Transition length in seconds, default 0.5."),
        motion: z.enum(["kenburns", "none"]).optional().describe("kenburns (default): slow zoom and pan. none: still images."),
        fit: z.enum(["cover", "contain"]).optional().describe("cover (default) fills the frame and crops; contain shows the whole image over a blurred copy of itself."),
        voiceover_text: z.string().min(1).max(10000).optional().describe("Narration to speak with text-to-speech (English)."),
        voice: z.enum(EN_VOICES).optional().describe("Text-to-speech voice, default luna."),
        voiceover_audio: z.string().min(1).optional().describe("Recorded narration instead of text-to-speech: local path or URL."),
        music: z.string().min(1).optional().describe("Background music: local path or URL. Looped or trimmed to fit, faded out and ducked under the voiceover."),
        music_volume: z.number().min(0).max(2).optional().describe("Music volume 0-2, default 0.2."),
        captions: z.enum(PRESETS).optional().describe("Burn in captions of the voiceover with this preset (see add_captions). Needs a voiceover."),
        quality,
      },
      annotations: opHints,
    },
    async (args, extra) =>
      tool(extra, async (ctx, { media, jobs }) => {
        const { images, duration_s, voiceover_text, voiceover_audio, music, music_volume, transition, transition_s } = args;
        if (voiceover_text && voiceover_audio) throw new ToolError("Pass voiceover_text or voiceover_audio, not both.");
        if (args.captions && !voiceover_text && !voiceover_audio) throw new ToolError("captions need a voiceover: add voiceover_text or voiceover_audio.");

        const perImage = args.seconds_per_image ?? (duration_s === undefined ? undefined : Math.round((duration_s / images.length) * 1000) / 1000);
        if (perImage !== undefined && (perImage < 0.5 || perImage > 60)) {
          throw new ToolError(`${duration_s} s over ${images.length} images is ${perImage} s per image; each image needs 0.5-60 s.`);
        }

        const [imageUrls, voiceUrl, musicUrl] = await Promise.all([
          Promise.all(images.map((image) => media.toUrl(image, ctx))),
          voiceover_audio ? media.toUrl(voiceover_audio, ctx) : undefined,
          music ? media.toUrl(music, ctx) : undefined,
        ]);

        const body = compact({
          images: imageUrls,
          size: args.size,
          seconds_per_image: perImage,
          transition: transition_s === undefined ? transition : { type: transition ?? "fade", seconds: transition_s },
          motion: args.motion,
          fit: args.fit,
          voiceover: voiceover_text ? compact({ text: voiceover_text, voice: args.voice }) : voiceUrl,
          music: musicUrl ? compact({ url: musicUrl, volume: music_volume }) : undefined,
          captions: args.captions,
          quality: args.quality,
        });
        return jobs.start("slideshow", body, "slideshow", ctx);
      }),
  );

  server.registerTool(
    "make_short",
    {
      title: "Make AI short",
      description: `Generate a finished faceless short (TikTok, Reels, YouTube Shorts) from a topic or a script: AI-written narration, an AI image per scene, voiceover, word-level captions and music, rendered to mp4 with a poster frame and subtitles. Use it when the user wants a new video about a subject; to edit their own footage use add_captions, make_slideshow or run_ffmpeg. Takes 1-2 minutes, so it usually returns a job_id first: call get_job until it's done. Returns local paths, a title and a ready-to-post caption.`,
      inputSchema: {
        topic: z.string().min(1).max(500).optional().describe('What the short is about, e.g. "the ghost ship Mary Celeste". AI writes the script.'),
        script: z.string().min(1).max(3000).optional().describe("Narration to use word for word instead; the length follows the script and topic only steers the visuals."),
        duration_s: z.number().int().min(15).max(90).optional().describe("Target length in topic mode, 15-90 s. Default 45."),
        aspect: z.enum(["9:16", "1:1", "16:9"]).optional().describe("Default 9:16 (1080x1920)."),
        style: z.enum(SHORT_STYLES).optional().describe("Look of the images; also sets the default music mood and caption preset. Default cinematic."),
        language: z.enum(["en", "es", "fr", "ja", "zh", "ko"]).optional().describe("Narration language, default en."),
        voice: z
          .enum([...EN_VOICES, ...ES_VOICES])
          .optional()
          .describe("Narrator. English voices (default luna) or Spanish voices (default aquila); ignored for fr, ja, zh and ko."),
        music: z.enum(MUSIC_MOODS).optional().describe("Music mood, default auto."),
        captions: z.enum([...PRESETS, "none"]).optional().describe("Caption preset, or none. Defaults to the style's preset."),
      },
      annotations: opHints,
    },
    async ({ captions, ...rest }, extra) =>
      tool(extra, async (ctx, { jobs }) => {
        if (!rest.topic && !rest.script) throw new ToolError("Pass a topic (AI writes the script) or a script (used word for word).");
        return jobs.start("shorts", compact({ ...rest, captions: captions === "none" ? false : captions }), undefined, ctx);
      }),
  );

  server.registerTool(
    "run_ffmpeg",
    {
      title: "Run ffmpeg",
      description: `Run any ffmpeg command in the cloud instead of installing ffmpeg: trim, crop (e.g. 16:9 to 9:16), resize, convert, compress, make GIFs, extract audio, concatenate, overlay, filter. Map bare filenames to local paths or URLs in inputs (local files are uploaded), use those names in args, and list the files to bring back in outputs. Example: inputs {"in.mp4": "./clip.mp4"}, args ["-i", "in.mp4", "-vf", "crop=ih*9/16:ih,scale=1080:1920", "-c:a", "copy", "out.mp4"], outputs ["out.mp4"]. Outputs are saved under ${settings.outputDir} with the same names. ${slow}`,
      inputSchema: {
        inputs: z.record(fileName, z.string().min(1)).optional().describe('Bare filename -> local path or http(s) URL, e.g. {"in.mp4": "./clip.mp4"}.'),
        args: z
          .union([z.array(z.string()).min(1).max(1000), z.string().min(1)])
          .describe("Arguments after `ffmpeg`, preferably as an array. No shell; refer to inputs and outputs by bare filename."),
        outputs: z.array(fileName).min(1).max(20).describe('Files your args write that should come back, e.g. ["out.mp4"].'),
        timeout_s: z.number().int().min(1).max(600).optional().describe("Stop ffmpeg after this many seconds, max 600."),
      },
      annotations: opHints,
    },
    async ({ inputs, args, outputs, timeout_s }, extra) =>
      tool(extra, async (ctx, { media, jobs }) => {
        const entries = Object.entries(inputs ?? {});
        const urls = await Promise.all(entries.map(([, source]) => media.toUrl(source, ctx)));
        const body = compact({ inputs: Object.fromEntries(entries.map(([name], index) => [name, urls[index]])), args, outputs, timeout_s });
        return jobs.start("ffmpeg", body, undefined, ctx);
      }),
  );

  server.registerTool(
    "get_job",
    {
      title: "Get job",
      description: `Wait for a reelsdk job that another tool returned as still running, then save its files locally just like the original call would have. Waits up to ${settings.waitSeconds} s per call; if it's still running, call it again. Also explains why a job failed.`,
      inputSchema: {
        job_id: z.string().regex(/^job_[a-z0-9]{20}$/, "job ids look like job_ followed by 20 lowercase letters and digits").describe("The job_id a tool returned."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ job_id }, extra) => tool(extra, (ctx, { jobs }) => jobs.resume(job_id, ctx)),
  );

  server.registerTool(
    "upload_file",
    {
      title: "Upload file",
      description: "Upload a local file (max 100 MB) and get a public URL that works for 7 days. The other tools upload local paths themselves, so only use this when you need the URL, e.g. to reuse one large file across several calls.",
      inputSchema: {
        path: z.string().min(1).describe("Local file path, absolute or relative to the project."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ path: input }, extra) =>
      tool(extra, async (ctx, { media }) => {
        const file = await media.localFile(input);
        const upload = await media.upload(file, ctx);
        return textResult(`Uploaded ${file.path} to ${upload.url}`, { path: file.path, ...upload });
      }),
  );
}

async function guard(extra: Extra, services: () => Services, work: Work): Promise<CallToolResult> {
  const ctx: ToolContext = { signal: extra.signal, startedAt: Date.now(), progress: progressReporter(extra) };
  try {
    return await work(ctx, services());
  } catch (error) {
    return errorResult(error);
  }
}

function progressReporter(extra: Extra): (message: string) => void {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return () => {};

  let progress = 0;
  return (message) => {
    progress += 1;
    extra
      .sendNotification({ method: "notifications/progress", params: { progressToken, progress, message } })
      .catch((error: unknown) => log("progress notification failed", error));
  };
}

function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

function stemOf(input: string): string {
  const value = input.trim();
  const raw = /^https?:\/\//i.test(value) && URL.canParse(value) ? safeDecode(new URL(value).pathname) : value;
  const base = path.basename(raw);
  const stem = base.slice(0, base.length - path.extname(base).length);
  return stem.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "-").trim().slice(0, 80) || "video";
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
