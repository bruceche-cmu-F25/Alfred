/** Turning push notifications on and off on this device (a phone paired through Tailscale). The service worker
 * (public/sw.js) only shows them. On an iPhone, Web Push works only in the app added to the home screen.
 */
import { api } from "./api.ts";

export type PushSupport = "ok" | "homeScreen" | "unsupported" | "denied";

const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
const standalone = () => window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;

export function pushSupport(): PushSupport {
  const capable = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  if (isIos() && !standalone()) return "homeScreen";
  if (!capable || !window.isSecureContext) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  return "ok";
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = (base64url + "=".repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  return navigator.serviceWorker.ready;
}

/** Call straight from a tap: iOS shows the permission prompt only inside the user's gesture. */
export async function enablePush(): Promise<void> {
  const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
  if (permission !== "granted") throw new Error("denied");
  const [{ publicKey }, worker] = await Promise.all([api.pushInfo(), registration()]);
  let subscription = await worker.pushManager.getSubscription();
  // A subscription made for another key (a home node that started over) cannot receive from this one.
  const key = subscription?.options.applicationServerKey;
  if (subscription && key && btoa(String.fromCharCode(...new Uint8Array(key))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") !== publicKey) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  await api.pushSubscribe(subscription.toJSON());
}

export async function disablePush(): Promise<void> {
  try {
    const worker = await navigator.serviceWorker.getRegistration("/");
    await (await worker?.pushManager.getSubscription())?.unsubscribe();
  } finally {
    await api.pushUnsubscribe();
  }
}
