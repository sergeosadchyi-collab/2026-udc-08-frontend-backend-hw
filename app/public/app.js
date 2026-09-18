// Minimal UI. No framework and no build step on purpose: the point of this
// homework is the seam between UI, API, database and authorization, not the
// view layer. Keep it that way — do not introduce a bundler.

const userSelect = document.querySelector("#user");
const list = document.querySelector("#notes");
const empty = document.querySelector("#empty");
const form = document.querySelector("#new-note");
const status = document.querySelector("#status");
const filterButtons = [...document.querySelectorAll("[data-filter]")];

/** Which slice of notes the list is showing: "active" | "archived". */
let filter = "active";

const EMPTY_TEXT = {
  active: "Активних нотаток немає. Додайте першу у формі вище.",
  archived: "В архіві порожньо. Заархівовані нотатки з’являться тут.",
};

function headers() {
  return { "content-type": "application/json", "x-user-id": userSelect.value };
}

function announce(message) {
  status.textContent = message;
}

/** fetch + the error handling the seeded version quietly skipped. */
async function api(path, options = {}) {
  const res = await fetch(path, { ...options, headers: headers() });
  if (!res.ok) {
    const problem = await res.json().catch(() => ({}));
    throw new Error(problem.error ?? `Помилка ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

function noteItem(note) {
  const li = document.createElement("li");
  if (note.archived) li.classList.add("is-archived");

  const grow = document.createElement("div");
  grow.className = "grow";

  const title = document.createElement("strong");
  title.textContent = note.title;
  const body = document.createElement("span");
  body.textContent = note.body;
  const when = document.createElement("small");
  when.textContent = note.created_at;
  grow.append(title, body, document.createElement("br"), when);

  // The archived state must be readable as text, not only as a dimmed card.
  if (note.archived) {
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = "В архіві";
    grow.prepend(badge);
  }

  const label = note.archived ? "Повернути з архіву" : "Архівувати";
  const archive = document.createElement("button");
  archive.type = "button";
  archive.textContent = label;
  // Visible text alone reads as "Архівувати" out of context in a button list,
  // so name each control with the note it acts on.
  archive.setAttribute("aria-label", `${label} нотатку «${note.title}»`);
  archive.addEventListener("click", () => toggleArchive(note));

  const del = document.createElement("button");
  del.type = "button";
  del.textContent = "Видалити";
  del.setAttribute("aria-label", `Видалити нотатку «${note.title}»`);
  del.addEventListener("click", async () => {
    try {
      await api(`/api/notes/${note.id}`, { method: "DELETE" });
      announce(`Нотатку «${note.title}» видалено.`);
      await load({ keepStatus: true });
    } catch (err) {
      announce(err.message);
    }
  });

  li.append(grow, archive, del);
  return li;
}

async function toggleArchive(note) {
  const goingToArchive = !note.archived;
  try {
    await api(`/api/notes/${note.id}/archive`, {
      method: "PATCH",
      body: JSON.stringify({ archived: goingToArchive }),
    });
    announce(
      goingToArchive
        ? `Нотатку «${note.title}» переміщено в архів.`
        : `Нотатку «${note.title}» повернуто з архіву.`,
    );
    await load({ keepStatus: true });
    // The button that had focus has just left the DOM — without this, focus
    // falls back to <body> and keyboard users lose their place.
    document.querySelector(`[data-filter="${filter}"]`)?.focus();
  } catch (err) {
    announce(err.message);
  }
}

async function load({ keepStatus = false } = {}) {
  if (!keepStatus) announce("");
  try {
    const notes = await api(`/api/notes?filter=${filter}`);
    list.replaceChildren(...notes.map(noteItem));
    empty.textContent = EMPTY_TEXT[filter];
    empty.hidden = notes.length > 0;
  } catch (err) {
    list.replaceChildren();
    empty.hidden = true;
    announce(err.message);
  }
}

filterButtons.forEach((button) => {
  button.addEventListener("click", () => {
    filter = button.dataset.filter;
    filterButtons.forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
    load();
  });
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = document.querySelector("#title");
  const body = document.querySelector("#body");
  try {
    await api("/api/notes", {
      method: "POST",
      body: JSON.stringify({ title: title.value, body: body.value }),
    });
    title.value = "";
    body.value = "";
    // A new note is active, so show the list where it actually landed.
    if (filter !== "active") {
      document.querySelector('[data-filter="active"]').click();
      return;
    }
    await load();
  } catch (err) {
    announce(err.message);
  }
});

userSelect.addEventListener("change", () => load());
load();
