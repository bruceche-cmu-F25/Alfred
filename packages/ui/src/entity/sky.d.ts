export type SkyState = "idle" | "listening" | "thinking" | "speaking" | "working" | "notice";

export interface Sky {
  setState(state: SkyState): void;
  setPaused(paused: boolean): void;
  setGaze(x: number, y: number): void;
  refreshPalette(): void;
  refresh(): void;
}

/** Renders into every `[data-sky]` canvas present when it is called. */
export function createSky(): Sky;
