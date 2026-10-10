// Tab screenshots for the picker (story 033, design.md Behaviour rule 4): one share prompt
// per tab, then every send is cropped from the live tab stream.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Size {
  w: number;
  h: number;
}
export type CaptureFailure = "refused" | "unsupported" | "not_this_tab";
export type StartResult = { ok: true } | { ok: false; reason: CaptureFailure };
export type GrabResult =
  { ok: true; png: Blob; w: number; h: number } | { ok: false; reason: "not_live" | "grab_failed" };

export const MAX_EDGE = 1568;
/** Zeo refuses a screenshot above this many decoded bytes (contract SCREENSHOT_MAX_BYTES). */
export const MAX_PNG_BYTES = 4 * 1024 * 1024;
const FRAME_WAIT_MS = 500;
const SHRINK_STEPS = 4;

/**
 * The union of `rects` (CSS px, viewport coordinates) in frame pixels, clamped to the frame.
 * The scale is frame width / viewport width: a tab capture is not guaranteed to run at
 * `devicePixelRatio`.
 */
export function cropRect(rects: readonly Rect[], viewport: Size, frame: Size): Rect {
  const sx = frame.w / viewport.w;
  const sy = frame.h / viewport.h;
  const left = Math.min(...rects.map((r) => r.x));
  const top = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.w));
  const bottom = Math.max(...rects.map((r) => r.y + r.h));
  const x0 = Math.max(0, Math.floor(left * sx));
  const y0 = Math.max(0, Math.floor(top * sy));
  const x1 = Math.min(frame.w, Math.ceil(right * sx));
  const y1 = Math.min(frame.h, Math.ceil(bottom * sy));
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

/**
 * Waits until the video shows a frame captured after the overlay was hidden. The capture
 * trails the page by about three painted frames (measured), so two are not enough. Bounded:
 * a hidden tab paints nothing and must not stall the grab.
 */
function cleanFrame(video: HTMLVideoElement): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), FRAME_WAIT_MS);
    const done = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const frames = (n: number, then: () => void) =>
      n === 0 ? then() : requestAnimationFrame(() => frames(n - 1, then));
    const withVideoFrames = video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
    };
    // Whichever comes first: a fresh video frame, or four painted frames. A page that does not
    // change sends no new video frame, so the callback alone would time out (measured).
    if (typeof withVideoFrames.requestVideoFrameCallback === "function") {
      frames(2, () => withVideoFrames.requestVideoFrameCallback!(done));
    }
    frames(4, done);
  });
}

/** Starts the video, or gives up after `FRAME_WAIT_MS`; never rejects. */
function playing(video: HTMLVideoElement): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), FRAME_WAIT_MS);
    video.play().then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        clearTimeout(timer);
        resolve(false);
      },
    );
  });
}

interface RegionCaptureTrack extends MediaStreamTrack {
  cropTo?: (target: unknown) => Promise<void>;
}
type CropTargetStatic = { fromElement(element: Element): Promise<unknown> };

/**
 * Whether the shared tab is this page. `preferCurrentTab` only suggests it: the user can pick
 * another tab. Region Capture's `cropTo` succeeds only on a capture of the calling tab, so a
 * rejection means another tab. Without the API (Firefox, WebKit) the check is skipped.
 */
async function isThisTab(track: RegionCaptureTrack): Promise<boolean> {
  const cropTarget = (globalThis as { CropTarget?: CropTargetStatic }).CropTarget;
  if (cropTarget === undefined || typeof track.cropTo !== "function") {
    return true;
  }
  try {
    await track.cropTo(await cropTarget.fromElement(document.documentElement));
    await track.cropTo(undefined);
    return true;
  } catch {
    return false;
  }
}

export class TabCapture {
  #stream: MediaStream | undefined;
  #video: HTMLVideoElement | undefined;
  /** A browser that can never share one tab: remembered, so it does not prompt on every send. */
  #unsupported = false;
  /** The prompt in progress: a second send while it is open waits for it instead of asking again. */
  #starting: Promise<StartResult> | undefined;
  /** Called when sharing ends, from Stop sharing or from the browser's own control. */
  onEnded: (() => void) | undefined;

  get isLive(): boolean {
    return this.#stream !== undefined;
  }

  /**
   * Asks to share the current tab. Must be called synchronously inside a user gesture:
   * `getDisplayMedia` is reached before any `await`, or the browser refuses it.
   */
  start(): Promise<StartResult> {
    if (this.#stream !== undefined) {
      return Promise.resolve({ ok: true });
    }
    if (this.#starting !== undefined) {
      return this.#starting;
    }
    const media = (globalThis.navigator as Navigator | undefined)?.mediaDevices;
    if (this.#unsupported || typeof media?.getDisplayMedia !== "function") {
      return Promise.resolve({ ok: false, reason: "unsupported" });
    }
    // A browser that cannot report the shared surface (Firefox) can never pass the surface
    // check below, so it is not asked at all: its window/screen prompt would only lead to the
    // no-image path, and a prompt nobody answers would hold the send forever.
    if (
      typeof media.getSupportedConstraints === "function" &&
      media.getSupportedConstraints().displaySurface !== true
    ) {
      this.#unsupported = true;
      return Promise.resolve({ ok: false, reason: "unsupported" });
    }
    let request: Promise<MediaStream>;
    try {
      request = media.getDisplayMedia({
        video: { displaySurface: "browser" },
        audio: false,
        preferCurrentTab: true,
        selfBrowserSurface: "include",
      } as DisplayMediaStreamOptions);
    } catch {
      return Promise.resolve({ ok: false, reason: "unsupported" });
    }
    const starting = request.then(
      async (stream): Promise<StartResult> => {
        const [track] = stream.getVideoTracks();
        const surface = (track?.getSettings() as { displaySurface?: string } | undefined)
          ?.displaySurface;
        const refuse = (reason: CaptureFailure): StartResult => {
          stream.getTracks().forEach((t) => t.stop());
          return { ok: false, reason };
        };
        if (track === undefined) {
          return refuse("not_this_tab");
        }
        if (surface === undefined) {
          // Firefox shares windows and screens, never one tab, and does not report a surface.
          this.#unsupported = true;
          return refuse("unsupported");
        }
        if (surface !== "browser" || !(await isThisTab(track))) {
          return refuse("not_this_tab");
        }
        track.addEventListener("ended", () => {
          if (this.#stream === stream) {
            this.#release();
          }
        });
        this.#stream = stream;
        return { ok: true };
      },
      (error: unknown): StartResult => {
        // NotSupportedError is the browser saying it cannot capture at all (e.g. a headless
        // build), not the user saying no: remembered, so later sends do not ask again.
        if (error instanceof Error && error.name === "NotSupportedError") {
          this.#unsupported = true;
          return { ok: false, reason: "unsupported" };
        }
        return { ok: false, reason: "refused" };
      },
    );
    this.#starting = starting;
    void starting.finally(() => {
      if (this.#starting === starting) {
        this.#starting = undefined;
      }
    });
    return starting;
  }

  /** Crops the live tab to `rects`, hiding the picker overlay for the frame. Never throws. */
  async grab(
    rects: readonly Rect[] | (() => readonly Rect[]),
    hideOverlay: (hidden: boolean) => void,
  ): Promise<GrabResult> {
    const stream = this.#stream;
    if (stream === undefined) {
      return { ok: false, reason: "not_live" };
    }
    hideOverlay(true);
    try {
      const video = this.#videoFor(stream);
      // Bounded like the frame wait: sends are queued one at a time, so a stream that never
      // starts playing would otherwise hold every later send too.
      if (video.readyState < 2 && !(await playing(video))) {
        return { ok: false, reason: "grab_failed" };
      }
      if (!(await cleanFrame(video))) {
        return { ok: false, reason: "grab_failed" };
      }
      const frame = { w: video.videoWidth, h: video.videoHeight };
      // Measured now, not when the send started: the page may have scrolled during the prompt.
      const current = typeof rects === "function" ? rects() : rects;
      const crop = cropRect(current, { w: innerWidth, h: innerHeight }, frame);
      if (crop.w === 0 || crop.h === 0) {
        return { ok: false, reason: "grab_failed" };
      }
      // Draw once at full crop size, then encode smaller until the PNG fits Zeo's limit: a
      // photo-heavy page can exceed 4 MiB at 1568 px.
      const source = document.createElement("canvas");
      source.width = crop.w;
      source.height = crop.h;
      const sourceCtx = source.getContext("2d");
      if (sourceCtx === null) {
        return { ok: false, reason: "grab_failed" };
      }
      sourceCtx.drawImage(video, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);
      hideOverlay(false);
      let scale = Math.min(1, MAX_EDGE / Math.max(crop.w, crop.h));
      for (let step = 0; step < SHRINK_STEPS; step++, scale *= 0.7) {
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(crop.w * scale));
        canvas.height = Math.max(1, Math.round(crop.h * scale));
        const ctx = canvas.getContext("2d");
        if (ctx === null) {
          return { ok: false, reason: "grab_failed" };
        }
        ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
        const png = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, "image/png"),
        );
        if (png === null) {
          return { ok: false, reason: "grab_failed" };
        }
        if (png.size <= MAX_PNG_BYTES) {
          return { ok: true, png, w: canvas.width, h: canvas.height };
        }
      }
      return { ok: false, reason: "grab_failed" };
    } catch {
      return { ok: false, reason: "grab_failed" };
    } finally {
      hideOverlay(false);
    }
  }

  stop(): void {
    this.#stream?.getTracks().forEach((t) => t.stop());
    this.#release();
  }

  #release(): void {
    const wasLive = this.#stream !== undefined;
    this.#stream = undefined;
    if (this.#video !== undefined) {
      this.#video.srcObject = null;
      this.#video = undefined;
    }
    if (wasLive) {
      this.onEnded?.();
    }
  }

  #videoFor(stream: MediaStream): HTMLVideoElement {
    if (this.#video === undefined) {
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      this.#video = video;
    }
    return this.#video;
  }
}
