/** The Mac app. It is one device on the home node, with what only a Mac can
 * do: a figure always on screen, a menu bar item, a global hotkey, system
 * notifications, and knowing when the user locks the screen and comes back.
 * The home node runs under launchd, so none of Alfred's work depends on it.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeTheme, Notification, powerMonitor, screen, shell, Tray,
  type IpcMainEvent, type MenuItemConstructorOptions,
} from "electron";
import type { AwayDigest, Notice, PresenceResponse, StateResponse } from "@alfred/protocol";
import { detectLocale, translate, type Key, type Locale } from "@alfred/ui/i18n";
import { welcomeLines } from "@alfred/ui/welcome";
import { HomeClient } from "./client.ts";
import { ensureHomeNode, healthy, homeNodeConfig, restartHomeNode, stopHomeNode, type HomeNodeMode } from "./home-node.ts";
import { appIcon, trayIcon } from "./icon.ts";

const HOTKEY = "Alt+Space";
const PRESENCE_SIZE = { width: 420, height: 116 };
/** Give a focused main window the first chance to show a result in place. */
const NOTIFY_GRACE_MS = 1500;
const HEARTBEAT_MS = 60_000;
const IDLE_AFTER_S = 300;
/** Locked, or no input for this long: the user is not at the Mac, so notices are left for the phone (push). */
const AWAY_FOR_NOTICES_S = 120;

app.setName("Alfred");
// The app's own files (window state, device id) live beside the world, never inside it:
// ~/Library/Application Support/Alfred/Desktop, or <data dir>/desktop for a development world.
app.setPath("userData", process.env.ALFRED_DATA_DIR ? join(process.env.ALFRED_DATA_DIR, "desktop") : join(app.getPath("appData"), "Alfred", "Desktop"));
if (!app.requestSingleInstanceLock()) app.quit();

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const preload = here("./preload.cjs");
const config = homeNodeConfig({ runtime: process.execPath, cli: here("../../server/src/cli.ts"), env: process.env });
const client = new HomeClient(config.port);

let main: BrowserWindow | null = null;
let presence: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let mode: HomeNodeMode | "stopped" = "stopped";
let settings = { showFigure: true };
const notifications = new Set<Notification>();
const handled = new Set<string>();

/** This Mac's device id, kept with the app's settings. */
function deviceId(): string {
  const file = join(app.getPath("userData"), "device.json");
  try {
    const stored = JSON.parse(readFileSync(file, "utf8")) as { id?: string };
    if (stored.id && /^[A-Za-z0-9._:-]{1,40}$/.test(stored.id)) return stored.id;
  } catch { /* first run */ }
  const id = `mac-${randomBytes(5).toString("hex")}`;
  mkdirSync(app.getPath("userData"), { recursive: true });
  writeFileSync(file, JSON.stringify({ id }));
  return id;
}

function loadSettings(): void {
  try { settings = { ...settings, ...JSON.parse(readFileSync(join(app.getPath("userData"), "settings.json"), "utf8")) }; } catch { /* defaults */ }
}
function saveSettings(): void {
  writeFileSync(join(app.getPath("userData"), "settings.json"), JSON.stringify(settings));
}

/** The first name macOS knows for this user, for greetings. Local only. */
function firstName(): string | null {
  try {
    const full = execFileSync("/usr/bin/id", ["-F"], { encoding: "utf8" }).trim();
    return full.split(/\s+/)[0] || null;
  } catch {
    return null;
  }
}

let DEVICE = "";
let USER: string | null = null;
/** The user's language: their setting on the home node once it is known, the system's until then. */
let LOCALE: Locale = detectLocale(app.getLocale());
const say = (key: Key, vars?: Record<string, string | number>) => translate(LOCALE, key, vars);

function windowArgs(role: "main" | "presence"): string[] {
  return [
    `--alfred-device=${encodeURIComponent(role === "main" ? `${DEVICE}.window` : `${DEVICE}.figure`)}`,
    `--alfred-role=${role}`,
    `--alfred-user=${encodeURIComponent(USER ?? "")}`,
  ];
}

const webPreferences = (role: "main" | "presence") => ({
  preload, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false, additionalArguments: windowArgs(role),
});

function sameOrigin(url: string): boolean {
  try { return new URL(url).origin === client.base; } catch { return false; }
}

function openExternal(url: string): void {
  try {
    if (["http:", "https:", "mailto:"].includes(new URL(url).protocol)) void shell.openExternal(url);
  } catch { /* not a URL */ }
}

function createMain(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1120, height: 760, minWidth: 720, minHeight: 480, show: false, title: "Alfred",
    titleBarStyle: "hiddenInset", trafficLightPosition: { x: 18, y: 22 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#171613" : "#fcf9f6", // the paper theme's page colour (tokens.css)
    webPreferences: webPreferences("main"),
  });
  window.on("close", (event) => {
    // Closing the window hides it; Alfred keeps running.
    if (!quitting) { event.preventDefault(); window.hide(); }
  });
  // The page cannot reliably tell it was hidden; the app tells it whether the user is looking.
  const attention = () => { if (!window.isDestroyed()) window.webContents.send("attention", window.isVisible() && window.isFocused()); };
  for (const change of ["focus", "blur", "show", "hide", "minimize", "restore"] as const) window.on(change as "focus", attention);
  window.webContents.on("did-finish-load", attention);
  window.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: "deny" }; });
  window.webContents.on("will-navigate", (event, url) => { if (!sameOrigin(url)) { event.preventDefault(); openExternal(url); } });
  void window.loadURL(`${client.base}/`);
  return window;
}

function createPresence(): BrowserWindow {
  const { workArea } = screen.getPrimaryDisplay();
  const window = new BrowserWindow({
    ...PRESENCE_SIZE,
    x: workArea.x + workArea.width - PRESENCE_SIZE.width - 8,
    y: workArea.y + workArea.height - PRESENCE_SIZE.height - 8,
    frame: false, transparent: true, resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
    alwaysOnTop: true, skipTaskbar: true, focusable: false, hasShadow: false, show: false, title: "Alfred",
    webPreferences: webPreferences("presence"),
  });
  window.setAlwaysOnTop(true, "floating");
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Clicks pass through the transparent parts; the page says when the pointer is on the figure.
  window.setIgnoreMouseEvents(true, { forward: true });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.once("ready-to-show", () => { if (settings.showFigure) window.showInactive(); });
  void window.loadURL(`${client.base}/presence.html`);
  return window;
}

function showMain(options: { runId?: string; composer?: boolean } = {}): void {
  if (!main || main.isDestroyed()) main = createMain();
  const window = main;
  const reveal = () => {
    window.show();
    window.focus();
    if (options.runId) window.webContents.send("focus-run", options.runId);
    if (options.composer) window.webContents.send("focus-composer");
  };
  if (window.webContents.isLoading()) window.webContents.once("did-finish-load", reveal);
  else reveal();
}

function toggleMain(): void {
  if (main?.isVisible() && main.isFocused()) main.hide();
  else showMain({ composer: true });
}

// ---- notices -------------------------------------------------------------

async function claimAndPresent(notice: Notice): Promise<boolean> {
  try {
    if (notice.state === "pending" || (notice.state === "claimed" && notice.claimedBy !== DEVICE)) {
      await client.post(`/api/notices/${notice.id}/claim`, { client: DEVICE });
    }
    await client.post(`/api/notices/${notice.id}/present`, { client: DEVICE });
    return true;
  } catch {
    return false; // another device has it
  }
}

function acknowledge(id: string): void {
  client.post(`/api/notices/${id}/acknowledge`, {}).catch(() => {});
}

async function greet(notice: Notice): Promise<void> {
  if (handled.has(notice.id)) return;
  handled.add(notice.id);
  if (!(await claimAndPresent(notice))) return;
  if (presence && !presence.isDestroyed() && presence.isVisible()) {
    presence.webContents.send("welcome", notice);
    return;
  }
  // The figure is hidden: greet with a notification instead.
  const { greeting, summary } = welcomeLines(notice.payload as unknown as AwayDigest, USER, LOCALE);
  notify(greeting, summary, () => { acknowledge(notice.id); showMain(); });
}

function notify(title: string, body: string, onClick: () => void): void {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title, body, silent: false });
  // Keep a reference, or a click after garbage collection is lost.
  notifications.add(notification);
  notification.on("click", () => { notifications.delete(notification); onClick(); });
  notification.on("close", () => notifications.delete(notification));
  notification.show();
}

function resultText(notice: Notice): { title: string; body: string } {
  const goal = String(notice.payload.goal ?? "");
  if (notice.kind === "run_interrupted") return { title: say("mac.interrupted.title"), body: say("mac.interrupted.body", { goal }) };
  if (notice.kind === "proposal") return { title: say("mac.proposal.title"), body: String(notice.payload.title ?? "") };
  if (notice.kind === "run_request") {
    return { title: say(notice.payload.kind === "permission" ? "mac.permission.title" : "mac.input.title"), body: String(notice.payload.question ?? goal) };
  }
  const status = notice.payload.status;
  if (status === "failed") return { title: say("mac.failed.title"), body: say("mac.goal", { goal }) };
  if (status === "cancelled") return { title: say("mac.cancelled.title"), body: say("mac.goal", { goal }) };
  return { title: "Alfred", body: String(notice.payload.reply ?? say("mac.done.body", { goal })) };
}

let notifyTimer: NodeJS.Timeout | null = null;

async function handleNotices(state: StateResponse): Promise<void> {
  const now = Date.now();
  const mainAttending = !!main && main.isVisible() && main.isFocused();
  // Nobody at the Mac: leave notices pending, and the home node pushes them to the phone. Back at the Mac, whatever
  // the phone did not take is shown here then.
  const atMac = powerMonitor.getSystemIdleState(AWAY_FOR_NOTICES_S) === "active";
  const results: Notice[] = [];
  for (const notice of state.notices) {
    if (handled.has(notice.id)) continue;
    if (notice.kind === "welcome") {
      if (notice.state === "pending" || (notice.state === "claimed" && notice.claimedBy === DEVICE)) await greet(notice);
      continue;
    }
    if (notice.kind !== "run_result" && notice.kind !== "run_interrupted" && notice.kind !== "run_request" && notice.kind !== "proposal") continue;
    if (notice.state !== "pending" || mainAttending || !atMac) continue;
    const age = now - Date.parse(notice.createdAt);
    if (age < NOTIFY_GRACE_MS) {
      if (!notifyTimer) notifyTimer = setTimeout(() => { notifyTimer = null; void refresh(); }, NOTIFY_GRACE_MS - age + 50);
      continue;
    }
    results.push(notice);
  }
  const presented: Notice[] = [];
  for (const notice of results) {
    handled.add(notice.id);
    if (await claimAndPresent(notice)) presented.push(notice);
  }
  if (presented.length === 1) {
    const [notice] = presented;
    const { title, body } = resultText(notice);
    // A question is closed by answering it, a proposal by deciding it; not by opening them.
    const open = notice.kind === "run_request" || notice.kind === "proposal";
    notify(title, body, () => { if (!open) acknowledge(notice.id); showMain({ runId: String(notice.payload.runId ?? "") }); });
  } else if (presented.length > 1) {
    notify("Alfred", say("mac.several", { n: presented.length }), () => { presented.filter((notice) => notice.kind !== "run_request" && notice.kind !== "proposal").forEach((notice) => acknowledge(notice.id)); showMain(); });
  }
}

let refreshing: Promise<void> | null = null;
/** The Dock shows how many things wait for the user (questions, interruptions), like unread messages. */
function dockBadge(state: StateResponse): void {
  const waiting = state.conversations.reduce((sum, conversation) => sum + conversation.attention, 0)
    + (state.proposals ?? []).filter((proposal) => !proposal.stale).length;
  app.dock?.setBadge(waiting ? String(waiting) : "");
}

/** Menus and notifications follow the user's language setting. */
function followLocale(state: StateResponse): void {
  const locale = state.settings?.locale;
  if (!locale || locale === LOCALE) return;
  LOCALE = locale;
  appMenu();
  updateTray();
}

function refresh(): Promise<void> {
  refreshing ??= client.state().then((state) => { followLocale(state); dockBadge(state); return handleNotices(state); }).catch(() => {}).finally(() => { refreshing = null; });
  return refreshing;
}

// ---- presence ------------------------------------------------------------

function reportPresence(kind: "active" | "away"): void {
  client.post<PresenceResponse>("/api/presence", { client: DEVICE, kind })
    .then((result) => { if (result.returned && result.notice) void greet(result.notice); })
    .catch(() => { /* the node is down; the next report catches up */ });
}

function watchPresence(): void {
  powerMonitor.on("lock-screen", () => reportPresence("away"));
  powerMonitor.on("suspend", () => reportPresence("away"));
  powerMonitor.on("unlock-screen", () => reportPresence("active"));
  setInterval(() => {
    if (powerMonitor.getSystemIdleState(IDLE_AFTER_S) === "active") reportPresence("active");
  }, HEARTBEAT_MS).unref();
  reportPresence("active");
}

// ---- menu bar, app menu, hotkey -------------------------------------------

function statusLabel(): string {
  if (mode === "stopped") return say("mac.node.stopped");
  if (!client.connected) return say("mac.node.connecting");
  return say(mode === "external" ? "mac.node.external" : "mac.node.live");
}

function updateTray(): void {
  if (!tray) return;
  const items: MenuItemConstructorOptions[] = [
    { label: statusLabel(), enabled: false },
    { label: say("mac.open"), accelerator: HOTKEY, click: () => showMain({ composer: true }) },
    {
      label: say("mac.showFigure"), type: "checkbox", checked: settings.showFigure, click: (item) => {
        settings.showFigure = item.checked;
        saveSettings();
        if (item.checked) presence?.showInactive(); else presence?.hide();
      },
    },
    { type: "separator" },
    {
      label: say("mac.node"), submenu: [
        { label: say("mac.node.restart"), enabled: mode === "launchd", click: () => void restartHomeNode(config).then(() => { mode = "launchd"; updateTray(); }) },
        { label: say(mode === "stopped" ? "mac.node.start" : "mac.node.stop"), enabled: mode !== "external", click: () => toggleHomeNode() },
        { label: say("mac.log"), enabled: existsSync(config.logFile), click: () => void shell.openPath(config.logFile) },
      ],
    },
    {
      label: say("mac.loginItem"), type: "checkbox", checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    { type: "separator" },
    { label: say("mac.quit"), click: () => app.quit() },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(items));
  tray.setToolTip(`Alfred · ${statusLabel()}`);
}

/** A node someone started by hand (npm start) went away: run our own under launchd. */
async function takeOver(): Promise<void> {
  if (mode !== "external" || client.connected || (await healthy(config.port))) return;
  try {
    mode = await ensureHomeNode(config);
  } catch (error) {
    mode = "stopped";
    showStartError(error);
  }
  updateTray();
}

function toggleHomeNode(): void {
  if (mode === "stopped") {
    void ensureHomeNode(config).then((next) => { mode = next; updateTray(); }).catch(showStartError);
  } else {
    stopHomeNode(config);
    mode = "stopped";
    updateTray();
  }
}

function appMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: "appMenu" },
    { role: "editMenu" },
    {
      label: say("mac.view"), submenu: [
        { role: "reload" }, { role: "toggleDevTools" }, { type: "separator" },
        { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ]));
}

function showStartError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const choice = dialog.showMessageBoxSync({
    type: "error", message: say("mac.startError"), detail: message, buttons: [say("mac.log"), say("mac.ok")], defaultId: 1,
  });
  if (choice === 0 && existsSync(config.logFile)) void shell.openPath(config.logFile);
}

function fromOurPages(event: IpcMainEvent): boolean {
  return sameOrigin(event.senderFrame?.url ?? "");
}

function wireIpc(): void {
  ipcMain.on("toggle-main", (event) => { if (fromOurPages(event)) toggleMain(); });
  ipcMain.on("open-main", (event, runId: unknown) => {
    if (fromOurPages(event)) showMain(typeof runId === "string" && runId ? { runId } : {});
  });
  ipcMain.on("set-interactive", (event, interactive: unknown) => {
    if (!fromOurPages(event) || !presence || event.sender !== presence.webContents) return;
    presence.setIgnoreMouseEvents(!interactive, { forward: true });
  });
  ipcMain.on("welcome-done", (event, noticeId: unknown) => {
    if (fromOurPages(event) && typeof noticeId === "string") acknowledge(noticeId);
  });
  // Adding a project: the user picks the folder in the system's own dialog, so the path is one they chose.
  ipcMain.handle("pick-folder", async (event) => {
    if (!sameOrigin(event.senderFrame?.url ?? "") || !main || event.sender !== main.webContents) return null;
    const picked = await dialog.showOpenDialog(main, { properties: ["openDirectory", "createDirectory"], message: say("mac.pickProject") });
    return picked.canceled ? null : picked.filePaths[0] ?? null;
  });
}

// ---- lifecycle -----------------------------------------------------------

app.on("second-instance", () => showMain({ composer: true }));
app.on("activate", () => showMain());
app.on("window-all-closed", () => { /* Alfred stays in the menu bar */ });
app.on("before-quit", () => { quitting = true; });
app.on("will-quit", () => globalShortcut.unregisterAll());

app.whenReady().then(async () => {
  DEVICE = deviceId();
  USER = firstName();
  loadSettings();
  appMenu();
  wireIpc();
  app.dock?.setIcon(appIcon());
  tray = new Tray(trayIcon());
  tray.on("click", () => tray?.popUpContextMenu());
  updateTray();

  try {
    mode = await ensureHomeNode(config);
  } catch (error) {
    mode = "stopped";
    updateTray();
    showStartError(error);
    return;
  }
  updateTray();
  client.follow(() => void refresh(), (connected) => {
    updateTray();
    if (!connected && mode === "external") setTimeout(() => void takeOver(), 3000);
  });

  presence = createPresence();
  if (!app.getLoginItemSettings().wasOpenedAtLogin) showMain();
  if (!globalShortcut.register(HOTKEY, toggleMain)) console.warn(`[alfred] could not register ${HOTKEY}`);
  watchPresence();
}).catch((error: unknown) => {
  console.error(error);
  showStartError(error);
});
