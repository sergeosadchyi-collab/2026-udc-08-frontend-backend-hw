import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createDb } from "../src/db.js";
import { createApp } from "../src/app.js";

let app;
beforeEach(() => {
  app = createApp(createDb(":memory:"));
});

const asOlya = (r) => r.set("x-user-id", "1");
const asTaras = (r) => r.set("x-user-id", "2");

/** Olya owns notes 1 and 2; note 3 belongs to Taras. */
const OLYA_NOTE = 1;
const TARAS_NOTE = 3;

const archive = (agent, id, payload) =>
  agent(request(app).patch(`/api/notes/${id}/archive`)).send(payload);

describe("PATCH /api/notes/:id/archive", () => {
  it("archives the caller's own note and reports the new state", async () => {
    const res = await archive(asOlya, OLYA_NOTE, { archived: true }).expect(200);
    expect(res.body.archived).toBe(true);
    expect(res.body.id).toBe(OLYA_NOTE);
  });

  it("moves the note out of the active list and into the archived list", async () => {
    await archive(asOlya, OLYA_NOTE, { archived: true }).expect(200);

    const active = await asOlya(request(app).get("/api/notes?filter=active")).expect(200);
    expect(active.body.map((n) => n.id)).not.toContain(OLYA_NOTE);

    const archived = await asOlya(request(app).get("/api/notes?filter=archived")).expect(200);
    expect(archived.body.map((n) => n.id)).toEqual([OLYA_NOTE]);
  });

  it("unarchives again — the flag is a toggle, not a one-way trip", async () => {
    await archive(asOlya, OLYA_NOTE, { archived: true }).expect(200);
    const res = await archive(asOlya, OLYA_NOTE, { archived: false }).expect(200);
    expect(res.body.archived).toBe(false);

    const active = await asOlya(request(app).get("/api/notes?filter=active")).expect(200);
    expect(active.body.map((n) => n.id)).toContain(OLYA_NOTE);
  });

  it("is idempotent — archiving an already archived note still succeeds", async () => {
    await archive(asOlya, OLYA_NOTE, { archived: true }).expect(200);
    const res = await archive(asOlya, OLYA_NOTE, { archived: true }).expect(200);
    expect(res.body.archived).toBe(true);
  });

  it("404s for a note that does not exist", async () => {
    await archive(asOlya, 999, { archived: true }).expect(404);
  });

  it("404s for a non-numeric id instead of throwing", async () => {
    await archive(asOlya, "abc", { archived: true }).expect(404);
  });

  it("rejects a request with no user header", async () => {
    await request(app)
      .patch(`/api/notes/${OLYA_NOTE}/archive`)
      .send({ archived: true })
      .expect(401);
  });
});

describe("PATCH /api/notes/:id/archive — authorization", () => {
  it("will not archive someone else's note", async () => {
    await archive(asOlya, TARAS_NOTE, { archived: true }).expect(404);
  });

  it("leaves the other user's note untouched after a failed attempt", async () => {
    await archive(asOlya, TARAS_NOTE, { archived: true }).expect(404);

    const taras = await asTaras(request(app).get("/api/notes?filter=active")).expect(200);
    expect(taras.body.map((n) => n.id)).toContain(TARAS_NOTE);
    expect(taras.body.find((n) => n.id === TARAS_NOTE).archived).toBe(false);
  });
});

describe("PATCH /api/notes/:id/archive — server-side validation", () => {
  // The UI only ever sends a real boolean. The point is that the server does
  // not rely on that: the client is under the user's control.
  it.each([
    ["a string", { archived: "true" }],
    ["a number", { archived: 1 }],
    ["null", { archived: null }],
    ["a missing field", {}],
    ["an unrelated field", { archive: true }],
  ])("rejects %s with 400", async (_label, payload) => {
    const res = await archive(asOlya, OLYA_NOTE, payload).expect(400);
    expect(res.body.error).toMatch(/boolean/);
  });

  it("does not change anything when validation fails", async () => {
    await archive(asOlya, OLYA_NOTE, { archived: "true" }).expect(400);
    const active = await asOlya(request(app).get("/api/notes?filter=active")).expect(200);
    expect(active.body.map((n) => n.id)).toContain(OLYA_NOTE);
  });

  it("answers malformed JSON with JSON, not an HTML error page", async () => {
    const res = await asOlya(request(app).patch(`/api/notes/${OLYA_NOTE}/archive`))
      .set("content-type", "application/json")
      .send("{not json")
      .expect(400);
    expect(res.body.error).toBe("malformed JSON body");
  });
});

describe("GET /api/notes — filtering", () => {
  it("defaults to active notes", async () => {
    await archive(asOlya, OLYA_NOTE, { archived: true }).expect(200);
    const res = await asOlya(request(app).get("/api/notes")).expect(200);
    expect(res.body.map((n) => n.id)).toEqual([2]);
  });

  it("returns both slices with filter=all", async () => {
    await archive(asOlya, OLYA_NOTE, { archived: true }).expect(200);
    const res = await asOlya(request(app).get("/api/notes?filter=all")).expect(200);
    expect(res.body).toHaveLength(2);
  });

  it("gives an empty array, not an error, when the archive is empty", async () => {
    const res = await asOlya(request(app).get("/api/notes?filter=archived")).expect(200);
    expect(res.body).toEqual([]);
  });

  it("rejects an unknown filter rather than silently listing everything", async () => {
    await asOlya(request(app).get("/api/notes?filter=everything")).expect(400);
  });

  it("does not let a filter value reach SQL", async () => {
    await asOlya(request(app).get("/api/notes?filter=active%3B%20DROP%20TABLE%20notes")).expect(400);
    // The table is still there and still answering.
    await asOlya(request(app).get("/api/notes")).expect(200);
  });

  it("never lists another user's notes, whatever the filter", async () => {
    const res = await asOlya(request(app).get("/api/notes?filter=all")).expect(200);
    expect(res.body.map((n) => n.id)).not.toContain(TARAS_NOTE);
  });
});

describe("response shape", () => {
  const PUBLIC_KEYS = ["id", "title", "body", "archived", "created_at"];

  it("exposes exactly the public fields when listing", async () => {
    const res = await asOlya(request(app).get("/api/notes")).expect(200);
    expect(Object.keys(res.body[0]).sort()).toEqual([...PUBLIC_KEYS].sort());
  });

  it("does not leak user_id when archiving", async () => {
    const res = await archive(asOlya, OLYA_NOTE, { archived: true }).expect(200);
    expect(res.body).not.toHaveProperty("user_id");
    expect(Object.keys(res.body).sort()).toEqual([...PUBLIC_KEYS].sort());
  });

  it("does not leak user_id when creating", async () => {
    const res = await asOlya(request(app).post("/api/notes"))
      .send({ title: "Нова" })
      .expect(201);
    expect(res.body).not.toHaveProperty("user_id");
    expect(res.body.archived).toBe(false);
  });
});

describe("POST /api/notes — length limits", () => {
  it("rejects an over-long title", async () => {
    await asOlya(request(app).post("/api/notes"))
      .send({ title: "я".repeat(201) })
      .expect(400);
  });

  it("accepts a title at the limit", async () => {
    await asOlya(request(app).post("/api/notes"))
      .send({ title: "я".repeat(200) })
      .expect(201);
  });

  it("rejects an over-long body", async () => {
    await asOlya(request(app).post("/api/notes"))
      .send({ title: "ок", body: "я".repeat(10_001) })
      .expect(400);
  });
});

