import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptProposal, CORE_MIGRATIONS, listOpenProposals, listOutbound, openWorld, updateSettings, type World } from "@alfred/core";
import { applyStep, assistantTools, runTools, ServiceError, type GoogleService } from "@alfred/module-kit";
import { calendarModule, deliverCalendar, listEvents, syncCalendar } from "../src/index.ts";

const world = (): World => openWorld(":memory:", [...CORE_MIGRATIONS, ...calendarModule.migrations]);
const signal = new AbortController().signal;
const today = new Date();
const at = (dayOffset: number, hours: number, minutes = 0) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + dayOffset, hours, minutes);
const pad = (n: number) => String(n).padStart(2, "0");
const local = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
const event = (w: World, title: string) => listEvents(w, "0000-01-01", "9999-12-31").find((candidate) => candidate.title === title)!;

interface Sent { method: string; url: string; body: unknown; headers?: Record<string, string> }
/** A Google Calendar with one meeting the user organizes and one invitation; `answers` scripts the replies to changes. */
function fakeGoogle(options: { capabilities?: string[]; answers?: Array<{ status: number; body?: Record<string, unknown> } | Error>; current?: Record<string, unknown> } = {}) {
  const sent: Sent[] = [];
  const answers = [...(options.answers ?? [])];
  const google: GoogleService = {
    accounts: () => [{ email: "me@example.com", capabilities: options.capabilities ?? ["calRead", "calWrite"] }],
    async session() {
      return {
        async get(url) {
          if (url.includes("/calendarList")) return { items: [{ id: "me@example.com", summary: "Me", primary: true, accessRole: "owner" }, { id: "team", summary: "Team", selected: true, accessRole: "reader" }] };
          if (url.endsWith("/events/standup")) return options.current ?? {};
          if (url.endsWith("/events/demo")) return { etag: "\"e9\"", attendees: [{ email: "vendor@x.com", organizer: true }, { email: "me@example.com", self: true, responseStatus: "needsAction" }] };
          if (url.includes("/calendars/team/")) return { items: [] };
          return { items: [
            { id: "standup", etag: "\"e1\"", summary: "Standup", start: { dateTime: at(1, 9, 30).toISOString() }, end: { dateTime: at(1, 9, 45).toISOString() },
              organizer: { self: true, email: "me@example.com" }, attendees: [{ self: true, responseStatus: "accepted" }, { email: "a@x.com" }, { email: "b@x.com" }] },
            { id: "demo", etag: "\"e9\"", summary: "Vendor demo", start: { dateTime: at(1, 14, 30).toISOString() }, end: { dateTime: at(1, 15).toISOString() },
              organizer: { email: "vendor@x.com" }, attendees: [{ email: "vendor@x.com" }, { self: true, responseStatus: "needsAction" }] },
          ] };
        },
        async send(method, url, body, init) {
          sent.push({ method, url: url.replace("https://www.googleapis.com/calendar/v3", ""), body, ...(init?.headers ? { headers: init.headers } : {}) });
          const next = answers.shift();
          if (next instanceof Error) throw next;
          return { status: next?.status ?? 200, body: next?.body ?? { id: "created", htmlLink: "https://calendar.google.com/e" } };
        },
      };
    },
  };
  return { google, sent };
}

/** Alfred proposes `calls` the way a run does (the propose tool), and the user accepts. */
async function proposeAndAccept(w: World, calls: Array<{ tool: string; params: Record<string, unknown> }>): Promise<void> {
  const propose = assistantTools(w, [calendarModule]).find((tool) => tool.name === "propose")!;
  const said = await propose.execute({ title: "Calendar changes?", summary: "", calls }, signal);
  assert.match(said, /^Proposed/, said);
  const [proposal] = listOpenProposals(w);
  assert.equal(acceptProposal(w, proposal.id, (step) => { applyStep(w, [calendarModule], step); }).state, "executed");
}

test("a run can only propose calendar changes: the tools are not offered to call, and propose names them", () => {
  const w = world();
  assert.deepEqual(runTools(w, [calendarModule]).map((tool) => tool.name), ["calendar_list"]);
  const propose = assistantTools(w, [calendarModule]).find((tool) => tool.name === "propose")!;
  assert.match(propose.description, /calendar_add, calendar_move, calendar_respond/);
});

test("holding time: proposed in the user's words, accepted, created under its own id, and safe to deliver twice", async () => {
  const w = world();
  const { google, sent } = fakeGoogle({ answers: [{ status: 503 }, { status: 409 }] });
  await syncCalendar(w, { google });
  updateSettings(w, { locale: "zh" });
  const start = at(2, 14), end = at(2, 16);
  await proposeAndAccept(w, [{ tool: "calendar_add", params: { title: "写方案", start: local(start), end: local(end) } }]);
  const [outbound] = listOutbound(w);
  assert.match(outbound.preview, /^在「Me」加「写方案」：.* 14:00–16:00$/);
  assert.equal(outbound.state, "queued");

  await deliverCalendar(w, { google }, signal);
  assert.equal(listOutbound(w)[0].state, "queued", "Google was down: tried again next pass");
  await deliverCalendar(w, { google }, signal);
  assert.equal(listOutbound(w)[0].state, "done", "409 on the second try: the first had made it");
  assert.equal(sent.length, 2);
  const body = sent[0].body as { id: string; summary: string; start: { dateTime: string } };
  assert.equal(sent[0].method, "POST");
  assert.equal(sent[0].url, "/calendars/me%40example.com/events?sendUpdates=none");
  assert.match(body.id, /^alfred[0-9a-v]{20}$/);
  assert.equal((sent[1].body as { id: string }).id, body.id, "the same event id both times");
  assert.deepEqual([body.summary, Date.parse(body.start.dateTime)], ["写方案", start.getTime()]);
});

test("moving: only events the user organizes, guests told, refused when Google's copy changed in between", async () => {
  const w = world();
  const { google, sent } = fakeGoogle({ answers: [{ status: 412 }], current: { start: { dateTime: at(1, 11).toISOString() } } });
  await syncCalendar(w, { google });
  const move = calendarModule.tools.find((tool) => tool.name === "calendar_move")!;
  const demo = event(w, "Vendor demo"), standup = event(w, "Standup");
  assert.deepEqual([standup.editable, standup.invited, demo.editable, demo.invited], [true, false, false, true]);
  assert.match(String((move.pin!(w, { event: demo.id, start: local(at(1, 16)), end: local(at(1, 17)) } as never) as { error: string }).error), /does not organize/);

  await proposeAndAccept(w, [{ tool: "calendar_move", params: { event: standup.id, start: local(at(1, 10)), end: local(at(1, 10, 15)) } }]);
  assert.match(listOutbound(w)[0].preview, /tells 2 other guests/);
  await deliverCalendar(w, { google }, signal);
  assert.deepEqual([sent[0].method, sent[0].url, sent[0].headers], ["PATCH", "/calendars/me%40example.com/events/standup?sendUpdates=all", { "If-Match": "\"e1\"" }]);
  assert.deepEqual([listOutbound(w)[0].state, listOutbound(w)[0].error], ["failed", "The event changed in Google since this was proposed"]);
});

test("a move cut off after Google made it counts as done, not as a conflict", async () => {
  const w = world();
  const target = { start: local(at(1, 10)), end: local(at(1, 10, 15)) };
  const { google } = fakeGoogle({ answers: [{ status: 412 }], current: { start: { dateTime: at(1, 10).toISOString() }, end: { dateTime: at(1, 10, 15).toISOString() } } });
  await syncCalendar(w, { google });
  await proposeAndAccept(w, [{ tool: "calendar_move", params: { event: event(w, "Standup").id, ...target } }]);
  await deliverCalendar(w, { google }, signal);
  assert.equal(listOutbound(w)[0].state, "done");
});

test("answering an invitation: only the user's own answer changes, and the organizer is told", async () => {
  const w = world();
  const { google, sent } = fakeGoogle();
  await syncCalendar(w, { google });
  await proposeAndAccept(w, [{ tool: "calendar_respond", params: { event: event(w, "Vendor demo").id, response: "declined" } }]);
  assert.match(listOutbound(w)[0].preview, /^Decline “Vendor demo”/);
  await deliverCalendar(w, { google }, signal);
  assert.equal(sent[0].url, "/calendars/me%40example.com/events/demo?sendUpdates=all");
  assert.deepEqual(sent[0].body, { attendees: [{ email: "vendor@x.com", organizer: true }, { email: "me@example.com", self: true, responseStatus: "declined" }] });
  assert.equal(listOutbound(w)[0].state, "done");
});

test("without the user's permission to change the calendar: nothing is proposed, and nothing is sent", async () => {
  const w = world();
  const readOnly = fakeGoogle({ capabilities: ["calRead"] });
  await syncCalendar(w, { google: readOnly.google });
  const add = calendarModule.tools.find((tool) => tool.name === "calendar_add")!;
  assert.match(String((add.pin!(w, { title: "Focus", start: local(at(1, 9)), end: local(at(1, 10)) } as never) as { error: string }).error), /Settings/);

  // Allowed when proposed, taken away before delivery: refused, nothing sent.
  await syncCalendar(w, { google: fakeGoogle().google });
  await proposeAndAccept(w, [{ tool: "calendar_add", params: { title: "Focus", start: local(at(1, 9)), end: local(at(1, 10)) } }]);
  await deliverCalendar(w, { google: readOnly.google }, signal);
  assert.equal(readOnly.sent.length, 0);
  assert.equal(listOutbound(w)[0].state, "failed");

  // Google stops honouring the account mid-delivery: failed, and says to reconnect.
  const revoked = fakeGoogle({ answers: [new ServiceError("reconnect", "Google refused the account's access")] });
  await proposeAndAccept(w, [{ tool: "calendar_add", params: { title: "Focus 2", start: local(at(1, 11)), end: local(at(1, 12)) } }]);
  await deliverCalendar(w, { google: revoked.google }, signal);
  assert.deepEqual(listOutbound(w).map((outbound) => [outbound.state, outbound.error?.slice(0, 22)]), [["failed", "No permission to chang"], ["failed", "Google refused the acc"]]);
});
