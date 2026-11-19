/** What the Mac app's preload exposes. Absent in an ordinary browser. */
import type { Notice } from "@alfred/protocol";

/** How a notice Alfred said left the screen: clicked through, closed, or it timed out unanswered. */
export type NoticeOutcome = "open" | "dismiss" | "timeout";
/** Which corner of the screen the figure was dragged toward; its card goes on the other side. */
export interface FigureSide { h: "left" | "right"; v: "top" | "bottom" }

export interface DesktopBridge {
  /** The name this window is handed notices under. */
  deviceId: string;
  role: "main" | "presence";
  /** The user's first name from macOS, for greetings. */
  userName: string | null;
  onFocusRun(listener: (runId: string) => void): () => void;
  onFocusComposer(listener: () => void): () => void;
  /** Main window: whether it is shown and focused, as the app sees it. */
  onAttention(listener: (attending: boolean) => void): () => void;
  /** Presence window: notices for Alfred to say (the welcome, results, questions, proposals). `visiting` when the
   * user hid the figure and it is shown only to say these; the page calls `settle` once it is done. */
  onSay(listener: (notices: Notice[], visiting: boolean) => void): () => void;
  /** Presence window: show or hide the main window. */
  toggleMain(): void;
  /** Open the main window, optionally at a run. */
  openMain(runId?: string): void;
  /** Presence window: whether the pointer is over something clickable (else clicks pass through). */
  setInteractive(interactive: boolean): void;
  /** Presence window: a notice Alfred said is off the screen, and how. */
  noticeDone(noticeId: string, outcome: NoticeOutcome): void;
  /** Presence window: nothing left to say; a figure that was only visiting can hide again. */
  settle(): void;
  /** Presence window: which corner the figure sits toward, now and whenever it is moved. */
  onSide(listener: (side: FigureSide) => void): () => void;
  /** Presence window: the user is dragging the figure; the app moves the window with the pointer. */
  dragFigure(phase: "start" | "move" | "end" | "cancel"): void;
  /** Presence window: the figure's right-click menu. */
  figureMenu(): void;
  /** Main window: the system's folder picker; the chosen folder's path, or null. Absent in older app builds. */
  pickFolder?(): Promise<string | null>;
}

declare global {
  interface Window { alfredDesktop?: DesktopBridge }
}

export const desktop: DesktopBridge | undefined = window.alfredDesktop;
