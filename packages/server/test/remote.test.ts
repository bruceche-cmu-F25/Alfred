import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CORE_MIGRATIONS, deviceForToken, listDevices, openWorld, pairDevice, revokeDevice, type EnginePort } from "@alfred/core";
import { todoModule } from "@alfred/module-todo";
import type { PairingCode, RemoteResponse } from "@alfred/protocol";
import { createHttpServer, createIngressServer, openHome, PushService, RemoteAccess, Tailscale, type Home, type Runner } from "../src/index.ts";

const DNS = "mini.tail1234.ts.net";
const OWNER = "bruce@example.com";
const engine: EnginePort = { submit: () => Promise.reject(new Error("no engine")) };

/** A machine's Tailscale: logged in, with something else already served on :443. */
function fakeTailscale(served: Record<string, string> = { [`${DNS}:443`]: "http://127.0.0.1:30141" }) {
  const calls: string[] = [];
  const run: Runner = async (args) => {
    calls.push(args.join(" "));
    if (args[0] === "status") return JSON.stringify({ BackendState: "Running", Self: { DNSName: `${DNS}.`, UserID: 7 }, User: { 7: { LoginName: OWNER } } });
    if (args.join(" ") === "serve status --json") {
      return JSON.stringify({ Web: Object.fromEntries(Object.entries(served).map(([key, proxy]) => [key, { Handlers: { "/": { Proxy: proxy } } }])) });
    }
    if (args[0] === "serve" && args[1] === "--bg") { served[`${DNS}:${args[2].split("=")[1]}`] = args[3]; return ""; }
    if (args[0] === "serve" && args[2] === "off") { delete served[`${DNS}:${args[1].split("=")[1]}`]; return ""; }
    throw new Error(`unexpected: ${args.join(" ")}`);
  };
  return { run, served, calls };
}

interface Reply { status: number; headers: IncomingHttpHeaders; body: Record<string, unknown> }
function ask(port: number, path: string, options: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = httpRequest({
      host: "127.0.0.1", port, path, method: options.method ?? (payload ? "POST" : "GET"),
      headers: { ...(payload ? { "Content-Type": "application/json" } : {}), ...options.headers },
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: text.startsWith("{") ? JSON.parse(text) : {} }));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

async function setUp(served?: Record<string, string>) {
  const dataDir = mkdtempSync(join(tmpdir(), "alfred-"));
  const home: Home = openHome({ dataDir, engine, modules: [todoModule] });
  const tailscale = fakeTailscale(served);
  // The ingress port must be known before RemoteAccess points Serve at it; the listener reads `remote` per request.
  const pushed: string[] = [];
  const secrets = new Map<string, string>();
  const push = new PushService({
    dataDir, world: home.world, send: async (subscription, payload) => { pushed.push(`${subscription.endpoint} ${payload}`); },
    secrets: { kind: "file", get: async (name) => secrets.get(name), set: async (name, value) => { secrets.set(name, value); }, delete: async (name) => { secrets.delete(name); } },
  });
  const options = { port: 0, uiDir: "/nonexistent", remote: undefined as unknown as RemoteAccess, push };
  const ingressServer = createIngressServer(home, options);
  const ingress = await listen(ingressServer);
  const remote = new RemoteAccess({ dataDir, world: home.world, tailscale: new Tailscale(tailscale.run), ingressPort: ingress });
  options.remote = remote;
  remote.events.on("revoked", (id) => push.unsubscribe(id));
  const localServer = createHttpServer(home, { port: 0, uiDir: "/nonexistent", remote, push });
  const local = await listen(localServer);
  await remote.restore();
  const close = () => {
    for (const server of [ingressServer, localServer]) { server.close(); server.closeAllConnections(); }
    home.close();
  };
  return { home, remote, tailscale, ingress, local, close, dataDir, pushed };
}

/** A request as Serve forwards it: the tailnet Host, the user's login. */
const viaServe = (extra: Record<string, string> = {}) => ({ Host: `${DNS}:4443`, "Tailscale-User-Login": OWNER, ...extra });

test("devices: tokens are kept only as hashes, and a revoked device is refused at once", () => {
  const world = openWorld(":memory:", CORE_MIGRATIONS);
  const token = "t".repeat(43);
  const device = pairDevice(world, { token, name: "Bruce's iPhone", kind: "phone", via: OWNER });
  const row = world.db.prepare("SELECT * FROM core_devices").get()!;
  assert.notEqual(row.token_hash, token);
  assert.equal(deviceForToken(world, token)?.id, device.id);
  assert.equal(deviceForToken(world, "nope"), null);
  revokeDevice(world, device.id);
  assert.equal(deviceForToken(world, token), null);
  assert.deepEqual(listDevices(world), []);
  const kinds = world.db.prepare("SELECT kind FROM core_events ORDER BY seq").all().map((event) => event.kind);
  assert.deepEqual(kinds, ["device.paired", "device.revoked"]);
  assert.throws(() => pairDevice(world, { token: "short", name: "x", kind: "phone" }), /32 characters/);
  world.close();
});

test("turning remote access on adds one Serve entry for Alfred and leaves the user's others alone", async () => {
  const { local, ingress, tailscale, close } = await setUp();
  try {
    const off = (await ask(local, "/api/remote")).body as Extract<RemoteResponse, { local: true }>;
    assert.equal(off.enabled, false);
    assert.equal(off.tailscale.dnsName, DNS);
    assert.equal(off.tailscale.owner, OWNER);

    const on = (await ask(local, "/api/remote", { body: { enabled: true } })).body as Extract<RemoteResponse, { local: true }>;
    assert.equal(on.serving, true);
    assert.equal(on.url, `https://${DNS}:4443`);
    assert.deepEqual(tailscale.served, { [`${DNS}:443`]: "http://127.0.0.1:30141", [`${DNS}:4443`]: `http://127.0.0.1:${ingress}` });

    const again = (await ask(local, "/api/remote", { body: { enabled: false } })).body as Extract<RemoteResponse, { local: true }>;
    assert.equal(again.serving, false);
    assert.deepEqual(tailscale.served, { [`${DNS}:443`]: "http://127.0.0.1:30141" });
  } finally { close(); }
});

test("a port already served by something else is left alone and reported", async () => {
  const { local, tailscale, close } = await setUp({ [`${DNS}:4443`]: "http://127.0.0.1:9999" });
  try {
    const on = (await ask(local, "/api/remote", { body: { enabled: true } })).body as Extract<RemoteResponse, { local: true }>;
    assert.equal(on.serving, false);
    assert.match(on.error ?? "", /used by something else/);
    assert.equal(tailscale.served[`${DNS}:4443`], "http://127.0.0.1:9999");
    assert.ok(!tailscale.calls.some((call) => call.startsWith("serve --bg")));
  } finally { close(); }
});

test("a device pairs with a one-time code, then reaches everything but credentials and other devices", async () => {
  const { local, ingress, close } = await setUp();
  try {
    await ask(local, "/api/remote", { body: { enabled: true } });

    // Not paired: the interface loads, the API does not.
    const unpaired = await ask(ingress, "/api/state", { headers: viaServe() });
    assert.equal(unpaired.status, 401);
    assert.equal(unpaired.body.code, "unpaired");
    assert.equal((await ask(ingress, "/api/pair", { headers: viaServe(), body: { code: "AAAA-AAAA", name: "Phone", kind: "phone" } })).body.code, "none");

    const pairing = (await ask(local, "/api/remote/pairing", { body: {} })).body as unknown as PairingCode;
    assert.match(pairing.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.equal(pairing.url, `https://${DNS}:4443/?pair=${pairing.code.replace("-", "")}`);
    // Pairing is for other devices; this machine cannot hand out codes from the ingress.
    assert.equal((await ask(ingress, "/api/remote/pairing", { headers: viaServe(), body: {} })).status, 401);

    assert.equal((await ask(ingress, "/api/pair", { headers: viaServe(), body: { code: "WRONGCOD", name: "Phone", kind: "phone" } })).body.code, "invalid");
    const paired = await ask(ingress, "/api/pair", { headers: viaServe(), body: { code: pairing.code.toLowerCase(), name: "Bruce's iPhone", kind: "phone" } });
    assert.equal(paired.status, 200);
    const cookie = String(paired.headers["set-cookie"]?.[0]);
    assert.match(cookie, /^alfred_device=[\w-]{43}; Path=\/; Max-Age=\d+; HttpOnly; Secure; SameSite=Strict$/);
    const token = cookie.split(";")[0];
    // The code was spent.
    assert.equal((await ask(ingress, "/api/pair", { headers: viaServe(), body: { code: pairing.code, name: "Again", kind: "phone" } })).body.code, "none");

    const as = viaServe({ Cookie: token });
    assert.equal((await ask(ingress, "/api/state", { headers: as })).status, 200);
    assert.equal((await ask(ingress, "/api/ops/todo.add", { headers: as, body: { requestId: "p-1", input: { title: "From the phone" } } })).status, 200);
    const self = (await ask(ingress, "/api/remote", { headers: as })).body as Extract<RemoteResponse, { local: false }>;
    assert.equal(self.local, false);
    assert.equal(self.device.name, "Bruce's iPhone");
    assert.equal(self.device.via, OWNER);
    for (const [path, body] of [["/api/connections", undefined], ["/api/remote", { enabled: false }], ["/api/remote/pairing", {}], [`/api/devices/${self.device.id}/revoke`, {}]] as const) {
      const reply = await ask(ingress, path, { headers: as, body });
      assert.equal(reply.status, 403, path);
      assert.equal(reply.body.code, "local_only", path);
    }

    // Another tailnet account's device is turned away even with a token; so is a foreign Host or Origin.
    assert.equal((await ask(ingress, "/api/state", { headers: viaServe({ Cookie: token, "Tailscale-User-Login": "friend@example.com" }) })).status, 403);
    assert.equal((await ask(ingress, "/api/state", { headers: { ...as, Host: "evil.example" } })).status, 403);
    assert.equal((await ask(ingress, "/api/ops/todo.add", { headers: { ...as, Origin: "https://evil.example" }, body: { requestId: "p-2", input: { title: "x" } } })).status, 403);
    // The local port does not accept the tailnet name: Serve only ever reaches the ingress.
    assert.equal((await ask(local, "/api/state", { headers: { Host: `${DNS}:4443` } })).status, 403);

    // The Mac sees the device; revoking it ends its open stream and refuses its next request.
    const listed = (await ask(local, "/api/remote")).body as Extract<RemoteResponse, { local: true }>;
    assert.deepEqual(listed.devices.map((device) => device.name), ["Bruce's iPhone"]);
    const stream = new Promise<string>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port: ingress, path: "/api/events", headers: as }, (res) => {
        assert.equal(res.statusCode, 200);
        res.on("data", () => {});
        res.on("end", () => resolve("ended"));
      });
      req.on("error", reject);
      req.end();
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await ask(local, `/api/devices/${self.device.id}/revoke`, { body: {} });
    assert.equal(await stream, "ended");
    assert.equal((await ask(ingress, "/api/state", { headers: as })).status, 401);
  } finally { close(); }
});

test("five wrong codes burn the code; a device can forget itself", async () => {
  const { local, ingress, close } = await setUp();
  try {
    await ask(local, "/api/remote", { body: { enabled: true } });
    const pairing = (await ask(local, "/api/remote/pairing", { body: {} })).body as unknown as PairingCode;
    for (let i = 0; i < 5; i++) assert.equal((await ask(ingress, "/api/pair", { headers: viaServe(), body: { code: "WRONGCOD", name: "x", kind: "phone" } })).body.code, "invalid");
    assert.equal((await ask(ingress, "/api/pair", { headers: viaServe(), body: { code: pairing.code, name: "x", kind: "phone" } })).body.code, "none");

    const fresh = (await ask(local, "/api/remote/pairing", { body: {} })).body as unknown as PairingCode;
    const paired = await ask(ingress, "/api/pair", { headers: viaServe(), body: { code: fresh.code, name: "Laptop", kind: "browser" } });
    const token = String(paired.headers["set-cookie"]?.[0]).split(";")[0];
    const forgot = await ask(ingress, "/api/device/forget", { headers: viaServe({ Cookie: token }), body: {} });
    assert.equal(forgot.status, 200);
    assert.match(String(forgot.headers["set-cookie"]?.[0]), /Max-Age=0/);
    assert.equal((await ask(ingress, "/api/state", { headers: viaServe({ Cookie: token }) })).status, 401);
    assert.equal(((await ask(local, "/api/remote")).body as Extract<RemoteResponse, { local: true }>).devices.length, 0);
    // This machine needs no pairing.
    assert.equal((await ask(local, "/api/pair", { body: { code: "x", name: "x", kind: "phone" } })).status, 400);
  } finally { close(); }
});

test("a paired device turns notifications on, gets a test one, and loses them when revoked", async () => {
  const { local, ingress, pushed, close } = await setUp();
  try {
    await ask(local, "/api/remote", { body: { enabled: true } });
    assert.equal((await ask(local, "/api/push")).status, 400);
    assert.equal((await ask(ingress, "/api/push", { headers: viaServe() })).status, 401);
    const pairing = (await ask(local, "/api/remote/pairing", { body: {} })).body as unknown as PairingCode;
    const paired = await ask(ingress, "/api/pair", { headers: viaServe(), body: { code: pairing.code, name: "iPhone", kind: "phone" } });
    const as = viaServe({ Cookie: String(paired.headers["set-cookie"]?.[0]).split(";")[0] });

    const info = (await ask(ingress, "/api/push", { headers: as })).body;
    assert.match(String(info.publicKey), /^[A-Za-z0-9_-]{80,}$/);
    assert.equal(info.subscribed, false);
    assert.equal((await ask(ingress, "/api/push/test", { headers: as, body: {} })).status, 409);
    assert.equal((await ask(ingress, "/api/push/subscribe", { headers: as, body: { subscription: { endpoint: "https://evil.example/x", keys: { p256dh: "a", auth: "b" } } } })).status, 400);
    const subscription = { endpoint: "https://web.push.apple.com/abc", keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA", auth: "tBHItJI5svbpez7KI4CCXg" } };
    assert.equal((await ask(ingress, "/api/push/subscribe", { headers: as, body: { subscription } })).body.subscribed, true);
    const listed = (await ask(local, "/api/remote")).body as Extract<RemoteResponse, { local: true }>;
    assert.equal(listed.devices[0].push, true);

    assert.equal((await ask(ingress, "/api/push/test", { headers: as, body: {} })).body.accepted, 1);
    assert.match(pushed[0], /^https:\/\/web\.push\.apple\.com\/abc .*Notifications work/);

    await ask(local, `/api/devices/${listed.devices[0].id}/revoke`, { body: {} });
    const after = (await ask(local, "/api/remote")).body as Extract<RemoteResponse, { local: true }>;
    assert.equal(after.devices.length, 0);
    assert.equal((await ask(ingress, "/api/push/test", { headers: as, body: {} })).status, 401);
  } finally { close(); }
});
