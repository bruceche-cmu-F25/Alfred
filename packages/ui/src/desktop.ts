/** What the Mac app's preload exposes. Absent in an ordinary browser. */
import type { Notice } from "@alfred/protocol";

export interface DesktopBridge {
  /** This window's device id for claiming notices. */
  deviceId: string;
  role: "main" | "presence";
  /** The user's first name from macOS, for greetings. */
  userName: string | null;
  onFocusRun(listener: (runId: string) => void): () => void;
  onFocusComposer(listener: () => void): () => void;
  /** Main window: whether it is shown and focused, as the app sees it. */
  onAttention(listener: (attending: boolean) => void): () => void;
  /** Presence window: a welcome this Mac claimed when the user came back. */
  onWelcome(listener: (notice: Notice) => void): () => void;
  /** Presence window: show or hide the main window. */
  toggleMain(): void;
  /** Open the main window, optionally at a run. */
  openMain(runId?: string): void;
  /** Presence window: whether the pointer is over something clickable (else clicks pass through). */
  setInteractive(interactive: boolean): void;
  /** Presence window: the welcome bubble closed; `opened` when the user clicked through. */
  welcomeDone(noticeId: string, opened: boolean): void;
  /** Main window: the system's folder picker; the chosen folder's path, or null. Absent in older app builds. */
  pickFolder?(): Promise<string | null>;
}

declare global {
  interface Window { alfredDesktop?: DesktopBridge }
}

export const desktop: DesktopBridge | undefined = window.alfredDesktop;
