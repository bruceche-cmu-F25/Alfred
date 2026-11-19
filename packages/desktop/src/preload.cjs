/* The only bridge between Alfred's pages and the Mac app. Sandboxed, so it
 * stays CommonJS and exposes a few narrow calls, nothing of Node or Electron.
 */
const { contextBridge, ipcRenderer } = require("electron");

function arg(name) {
  const prefix = `--alfred-${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? decodeURIComponent(found.slice(prefix.length)) : null;
}

function listen(channel, handler) {
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld("alfredDesktop", {
  deviceId: arg("device"),
  role: arg("role"),
  userName: arg("user") || null,
  onFocusRun: (listener) => listen("focus-run", (_event, runId) => listener(String(runId))),
  onFocusComposer: (listener) => listen("focus-composer", () => listener()),
  onAttention: (listener) => listen("attention", (_event, attending) => listener(Boolean(attending))),
  onWelcome: (listener) => listen("welcome", (_event, notice) => listener(notice)),
  toggleMain: () => ipcRenderer.send("toggle-main"),
  openMain: (runId) => ipcRenderer.send("open-main", typeof runId === "string" ? runId : null),
  setInteractive: (interactive) => ipcRenderer.send("set-interactive", Boolean(interactive)),
  welcomeDone: (noticeId, opened) => ipcRenderer.send("welcome-done", String(noticeId), Boolean(opened)),
  /** Main window: the system's folder picker; resolves with the chosen folder's path, or null. */
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
});
