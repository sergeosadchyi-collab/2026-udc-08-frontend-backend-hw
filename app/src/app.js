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
 */
function currentUser(req, res, next) {
  const id = Number(req.header("x-user-id"));
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(401).json({ error: "not authenticated" });
  }
  req.userId = id;
  next();
}

export function createApp(db) {
  const app = express();
  app.use(express.json());
  app.use(express.static(resolve(here, "../public")));

  app.use("/api", currentUser);

  // List the caller's own notes. `filter` selects the slice the UI shows;
  // it is whitelisted here rather than interpolated into SQL.
  app.get("/api/notes", (req, res) => {
    const filter = req.query.filter ?? "active";
    const where = { active: "AND archived = 0", archived: "AND archived = 1", all: "" }[filter];
    if (where === undefined) return res.status(400).json({ error: "unknown filter" });

    const rows = db
      .prepare(
        `SELECT id, title, body, archived, created_at
           FROM notes
          WHERE user_id = ? ${where}
          ORDER BY id`,
      )
      .all(req.userId)
      .map((row) => ({ ...row, archived: Boolean(row.archived) }));
    res.json(rows);
  });

  // Toggle the archived flag on one of the caller's own notes.
  app.patch("/api/notes/:id/archive", (req, res) => {
    // The client is user-controlled, so the value is validated here even
    // though the UI only ever sends a real boolean.
    const archived = req.body?.archived;
    if (typeof archived !== "boolean") {
      return res.status(400).json({ error: "archived must be a boolean" });
    }

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: "not found" });

    // Scoped to the caller: someone else's note is "not found", never a 403
    // that would confirm it exists.
    const info = db
      .prepare("UPDATE notes SET archived = ? WHERE id = ? AND user_id = ?")
      .run(archived ? 1 : 0, id, req.userId);
    if (info.changes === 0) return res.status(404).json({ error: "not found" });

    const note = db
      .prepare("SELECT id, title, body, archived, created_at FROM notes WHERE id = ?")
      .get(id);
    res.json({ ...note, archived: Boolean(note.archived) });
  });

  // Read one note.
  app.get("/api/notes/:id", (req, res) => {
    const note = db
      .prepare("SELECT id, user_id, title, body, created_at FROM notes WHERE id = ?")
      .get(Number(req.params.id));
    if (!note) return res.status(404).json({ error: "not found" });
    res.json(note);
  });

  // Create a note for the caller.
  app.post("/api/notes", (req, res) => {
    const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
    const body = typeof req.body?.body === "string" ? req.body.body : "";
    if (!title) return res.status(400).json({ error: "title is required" });

    const info = db
      .prepare("INSERT INTO notes (user_id, title, body) VALUES (?, ?, ?)")
      .run(req.userId, title, body);
    const created = db
      .prepare("SELECT id, title, body, created_at FROM notes WHERE id = ?")
      .get(info.lastInsertRowid);
    res.status(201).json(created);
  });

  // Delete one of the caller's own notes.
  app.delete("/api/notes/:id", (req, res) => {
    const info = db
      .prepare("DELETE FROM notes WHERE id = ? AND user_id = ?")
      .run(Number(req.params.id), req.userId);
    if (info.changes === 0) return res.status(404).json({ error: "not found" });
    res.status(204).end();
  });

  return app;
}
