import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Pretend session. A real app would verify a signed cookie or a JWT here;
 * that is deliberately out of scope — this workshop is about what happens
 * AFTER you know who the caller is.
 *
 * The caller identifies itself with the `x-user-id` header. Seeded users are
 * 1 (Оля) and 2 (Тарас).
 *
 * The header is still just a number, but the number now has to name a user
 * that actually exists. Trusting any positive integer let a caller act as a
 * user who was never created — which reached the database and came back as a
 * foreign-key crash instead of an authentication failure.
 */
function makeCurrentUser(db) {
  const findUser = db.prepare("SELECT id FROM users WHERE id = ?");

  return function currentUser(req, res, next) {
    const id = Number(req.header("x-user-id"));
    if (!Number.isInteger(id) || id <= 0 || !findUser.get(id)) {
      return res.status(401).json({ error: "not authenticated" });
    }
    req.userId = id;
    next();
  };
}

/**
 * The only shape of a note that ever leaves this process.
 *
 * `user_id` is deliberately absent: the caller already knows who they are, and
 * a column used only for authorization has no business in a response. Every
 * handler selects exactly these columns, so a column added to the table later
 * cannot leak by default.
 */
const NOTE_FIELDS = "id, title, body, archived, created_at";

/** SQLite has no boolean type; normalise 0/1 at the edge, in one place. */
const toNote = (row) => ({ ...row, archived: Boolean(row.archived) });

const TITLE_MAX = 200;
const BODY_MAX = 10_000;

/** Whitelisted list filters → the SQL fragment each one appends. */
const LIST_FILTERS = {
  active: "AND archived = 0",
  archived: "AND archived = 1",
  all: "",
};

export function createApp(db) {
  const app = express();
  app.use(express.json());
  app.use(express.static(resolve(here, "../public")));

  app.use("/api", makeCurrentUser(db));

  // List the caller's own notes. `filter` picks the slice the UI shows; it is
  // looked up in a whitelist, never interpolated from user input.
  app.get("/api/notes", (req, res) => {
    const filter = req.query.filter ?? "active";
    const where = typeof filter === "string" ? LIST_FILTERS[filter] : undefined;
    if (where === undefined) {
      return res.status(400).json({ error: "filter must be active, archived or all" });
    }

    const rows = db
      .prepare(
        `SELECT ${NOTE_FIELDS}
           FROM notes
          WHERE user_id = ? ${where}
          ORDER BY id`,
      )
      .all(req.userId);
    res.json(rows.map(toNote));
  });

  // Toggle the archived flag on one of the caller's own notes.
  app.patch("/api/notes/:id/archive", (req, res) => {
    // The client is user-controlled, so the value is validated here even
    // though the UI only ever sends a real boolean. A string "true" or a 1
    // is a bug in the caller, not something to coerce and quietly accept.
    const archived = req.body?.archived;
    if (typeof archived !== "boolean") {
      return res.status(400).json({ error: "archived must be a boolean" });
    }

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: "not found" });

    // Scoped to the caller, not just to the id. Someone else's note is
    // "not found" — a 403 would confirm that the id exists.
    const info = db
      .prepare("UPDATE notes SET archived = ? WHERE id = ? AND user_id = ?")
      .run(archived ? 1 : 0, id, req.userId);
    if (info.changes === 0) return res.status(404).json({ error: "not found" });

    const note = db.prepare(`SELECT ${NOTE_FIELDS} FROM notes WHERE id = ?`).get(id);
    res.json(toNote(note));
  });

  // Read one of the caller's own notes.
  //
  // This route used to be `WHERE id = ?` and returned `user_id` with the row,
  // so any logged-in user could read any note by guessing an id. The boundary
  // has to come from the session, not from the id in the URL: the question is
  // not "does this note exist" but "may THIS caller see THIS note".
  //
  // The ownership condition belongs in the query itself. Fetching the row and
  // then comparing `note.user_id !== req.userId` would also work, but then the
  // data has already left the database before anyone asks about permissions —
  // one early `return` away from leaking again.
  app.get("/api/notes/:id", (req, res) => {
    const note = db
      .prepare(`SELECT ${NOTE_FIELDS} FROM notes WHERE id = ? AND user_id = ?`)
      .get(Number(req.params.id), req.userId);
    // 404, not 403: a 403 would confirm that the id exists.
    if (!note) return res.status(404).json({ error: "not found" });
    res.json(toNote(note));
  });

  // Create a note for the caller.
  app.post("/api/notes", (req, res) => {
    const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
    const body = typeof req.body?.body === "string" ? req.body.body : "";
    if (!title) return res.status(400).json({ error: "title is required" });
    // Unbounded text is a server problem, not a UI one: `maxlength` in the
    // form is a hint, and nothing stops a caller from skipping the form.
    if (title.length > TITLE_MAX) {
      return res.status(400).json({ error: `title must be at most ${TITLE_MAX} characters` });
    }
    if (body.length > BODY_MAX) {
      return res.status(400).json({ error: `body must be at most ${BODY_MAX} characters` });
    }

    const info = db
      .prepare("INSERT INTO notes (user_id, title, body) VALUES (?, ?, ?)")
      .run(req.userId, title, body);
    const created = db
      .prepare(`SELECT ${NOTE_FIELDS} FROM notes WHERE id = ?`)
      .get(info.lastInsertRowid);
    res.status(201).json(toNote(created));
  });

  // Delete one of the caller's own notes.
  app.delete("/api/notes/:id", (req, res) => {
    const info = db
      .prepare("DELETE FROM notes WHERE id = ? AND user_id = ?")
      .run(Number(req.params.id), req.userId);
    if (info.changes === 0) return res.status(404).json({ error: "not found" });
    res.status(204).end();
  });

  // API errors answer JSON, and answer it without a stack trace: Express's
  // default handler renders absolute file paths and internal frames into the
  // response body, which is free reconnaissance for an attacker.
  // eslint-disable-next-line no-unused-vars -- Express needs the 4-arg shape
  app.use("/api", (err, req, res, next) => {
    if (err instanceof SyntaxError && "body" in err) {
      return res.status(400).json({ error: "malformed JSON body" });
    }
    console.error(err);
    res.status(500).json({ error: "internal error" });
  });

  return app;
}

