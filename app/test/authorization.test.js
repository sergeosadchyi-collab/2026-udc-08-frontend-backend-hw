import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createDb } from "../src/db.js";
import { createApp } from "../src/app.js";

/**
 * Authorization, asked as a question the seeded suite never asked.
 *
 * The existing tests cover "can Olya delete someone else's note" but never
 * "can Olya *read* someone else's note" — which is why all 9 of them stayed
 * green while `GET /api/notes/:id` handed out any row by id.
 *
 * Every test here must fail on the code as it was before the fix.
 */

let app;
beforeEach(() => {
  app = createApp(createDb(":memory:"));
});

const asOlya = (r) => r.set("x-user-id", "1");
const asTaras = (r) => r.set("x-user-id", "2");

/** Olya owns notes 1 and 2; note 3 is Taras's private one. */
const OLYA_NOTE = 1;
const TARAS_NOTE = 3;
const TARAS_SECRET = "пароль від сейфа: 1234";

describe("GET /api/notes/:id — reading someone else's note", () => {
  it("will not read someone else's note", async () => {
    await asOlya(request(app).get(`/api/notes/${TARAS_NOTE}`)).expect(404);
  });

  it("does not leak the body of someone else's note in any form", async () => {
    const res = await asOlya(request(app).get(`/api/notes/${TARAS_NOTE}`));
    expect(JSON.stringify(res.body)).not.toContain(TARAS_SECRET);
  });

  it("answers 404 rather than 403, so the id is not confirmed to exist", async () => {
    const someoneElses = await asOlya(request(app).get(`/api/notes/${TARAS_NOTE}`));
    const nonExistent = await asOlya(request(app).get("/api/notes/999"));
    expect(someoneElses.status).toBe(nonExistent.status);
    expect(someoneElses.body).toEqual(nonExistent.body);
  });

  it("still lets the owner read their own note", async () => {
    const res = await asTaras(request(app).get(`/api/notes/${TARAS_NOTE}`)).expect(200);
    expect(res.body.title).toBe("Приватна нотатка Тараса");
  });

  it("does not return user_id to the owner either", async () => {
    const res = await asOlya(request(app).get(`/api/notes/${OLYA_NOTE}`)).expect(200);
    expect(res.body).not.toHaveProperty("user_id");
  });

  it("requires authentication", async () => {
    await request(app).get(`/api/notes/${TARAS_NOTE}`).expect(401);
  });
});

/**
 * Every route that takes an :id, walked with the wrong user. The boundary of
 * the data a route returns must come from the session, never from the id in
 * the URL alone.
 */
describe("every :id route refuses the wrong user", () => {
  it.each([
    ["GET", (r) => r.get(`/api/notes/${TARAS_NOTE}`), undefined],
    ["DELETE", (r) => r.delete(`/api/notes/${TARAS_NOTE}`), undefined],
    ["PATCH archive", (r) => r.patch(`/api/notes/${TARAS_NOTE}/archive`), { archived: true }],
  ])("%s /api/notes/:id as the wrong user → 404", async (_label, route, payload) => {
    const req = asOlya(route(request(app)));
    await (payload ? req.send(payload) : req).expect(404);
  });

  it("leaves Taras's note intact after Olya has tried every route", async () => {
    await asOlya(request(app).get(`/api/notes/${TARAS_NOTE}`));
    await asOlya(request(app).delete(`/api/notes/${TARAS_NOTE}`));
    await asOlya(request(app).patch(`/api/notes/${TARAS_NOTE}/archive`)).send({ archived: true });

    const taras = await asTaras(request(app).get("/api/notes?filter=all")).expect(200);
    expect(taras.body).toHaveLength(1);
    expect(taras.body[0]).toMatchObject({ id: TARAS_NOTE, archived: false });
  });
});

/**
 * Found while walking the routes with a wrong header: the middleware accepted
 * any positive integer, so a caller could claim to be a user who does not
 * exist. Reading was harmless (an empty list), but writing reached the
 * foreign key and crashed with a stack trace in the response body.
 */
describe("authentication — a user id that does not exist", () => {
  const asGhost = (r) => r.set("x-user-id", "999");

  it("rejects a header naming a user that was never created", async () => {
    await asGhost(request(app).get("/api/notes")).expect(401);
  });

  it("cannot create a note as a non-existent user", async () => {
    await asGhost(request(app).post("/api/notes")).send({ title: "ghost" }).expect(401);
  });

  it.each([
    ["zero", "0"],
    ["negative", "-1"],
    ["non-numeric", "abc"],
    ["empty", ""],
    ["a float", "1.5"],
  ])("rejects %s user ids", async (_label, value) => {
    await request(app).get("/api/notes").set("x-user-id", value).expect(401);
  });

  it("never answers with a stack trace", async () => {
    const res = await asGhost(request(app).post("/api/notes")).send({ title: "ghost" });
    expect(res.text).not.toMatch(/SqliteError|at Layer|node_modules/);
  });
});


