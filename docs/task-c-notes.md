# Task C — авторизація

## C1. Мій ендпоінт з Task B

`PATCH /api/notes/:id/archive` перевіряє власника **умовою в самому запиті**:

```js
db.prepare("UPDATE notes SET archived = ? WHERE id = ? AND user_id = ?")
  .run(archived ? 1 : 0, id, req.userId);
if (info.changes === 0) return res.status(404).json({ error: "not found" });
```

Межа даних береться з сесії (`req.userId`), а не з `id` в URL. Якщо нотатка
чужа — `UPDATE` не зачіпає жодного рядка, і відповідь `404`.

Чому `404`, а не `403`: `403` підтвердив би, що нотатка з таким `id` існує.
Відповідь на чужу нотатку побайтово збігається з відповіддю на неіснуючу — є
тест, який порівнює і статус, і тіло.

---

## C2. Засіяна діра

### Відтворення (до правки)

```
$ curl -s -H "x-user-id: 1" http://localhost:3080/api/notes/3
{"id":3,"user_id":2,"title":"Приватна нотатка Тараса",
 "body":"пароль від сейфа: 1234","created_at":"2026-09-18 13:06:53"}
HTTP 200
```

Оля (`x-user-id: 1`) прочитала приватну нотатку Тараса (`user_id: 2`) —
разом із вмістом «пароль від сейфа: 1234» і з внутрішнім полем `user_id`.
Достатньо було підставити інший `id` в URL.

Контраст, який показує, що це саме діра, а не загальна поведінка:

| Запит від Олі на нотатку 3 | До правки |
|---|---|
| `GET /api/notes/3` | **200 + дані** ← |
| `DELETE /api/notes/3` | 404 |
| `PATCH /api/notes/3/archive` | 404 |

Тобто видалення й архівування були заскоуплені по власнику, а читання — ні.

### Причина

```js
// було
.prepare("SELECT id, user_id, title, body, created_at FROM notes WHERE id = ?")
.get(Number(req.params.id));
```

Умова `WHERE id = ?` і більше нічого. Межа даних бралася **з URL**, тобто з
того, що повністю контролює користувач. Плюс у відповідь віддавалося `user_id`.

### Правка

```js
// стало
.prepare(`SELECT ${NOTE_FIELDS} FROM notes WHERE id = ? AND user_id = ?`)
.get(Number(req.params.id), req.userId);
```

Умова по власнику — **в самому запиті**, а не перевіркою `note.user_id !== req.userId`
після того, як рядок уже дістали. Це принципово: у другому варіанті дані вже
вийшли з бази, і достатньо одного раннього `return` або зміни порядку рядків,
щоб вони знову потрапили у відповідь. Якщо запит нічого не повернув — ділитися
просто нічим.

`user_id` прибрано з відповіді: тепер використовується спільний `NOTE_FIELDS`,
той самий, що й в інших маршрутах.

### Тест, який червонів до правки

`app/test/authorization.test.js`. Перевірено на коді **до правки Task C** — це
коміт `8b97845` (Task A і B уже зроблені, але маршрут `GET /api/notes/:id`
лишався рівно таким, як засіяний):

```
$ git show HEAD:app/src/app.js > app/src/app.js   # тимчасово
$ npx vitest run test/authorization.test.js
  Tests  8 failed | 10 passed (18)
```

З цих 8 падінь 5 — про засіяну діру, 3 — про побічні знахідки (див. нижче).
Серед падінь — саме ті твердження, заради яких тест писався:

```
→ expected 404 "Not Found", got 200 "OK"
→ expected '{"id":3,"user_id":2,"title":"Приватна…' not to contain 'пароль від сейфа: 1234'
→ expected { id: 1, user_id: 1, …(3) } to not have property "user_id"
```

Після правки:

```
Test Files  3 passed (3)
     Tests  55 passed (55)
```

Ключовий тест — дзеркало наявного `will not delete someone else's note`, але
на **читання**:

```js
it("will not read someone else's note", async () => {
  await asOlya(request(app).get(`/api/notes/${TARAS_NOTE}`)).expect(404);
});
```

---

## Побічні знахідки

Проходячи кожен маршрут «не тим користувачем», знайшлося ще дві речі. Обидві —
не та діра, що засіяна, але обидві реальні.

### 1. `x-user-id` приймав будь-яке додатне число

Middleware перевіряв лише формат:

```js
if (!Number.isInteger(id) || id <= 0) return res.status(401)...
```

Тобто `x-user-id: 999` вважався автентифікованим користувачем, якого не існує.
На читанні це було нешкідливо (порожній список), а на записі доходило до
foreign key:

```
$ curl -X POST -H "x-user-id: 999" ... /api/notes
HTTP 500
SqliteError: FOREIGN KEY constraint failed
```

Виправлено: middleware звіряє, що такий користувач справді є. Схему
`x-user-id` не змінено — просто число тепер має когось означати.

### 2. 500-ка віддавала стек-трейс

Та сама відповідь містила повний стек із абсолютними шляхами файлової системи
й внутрішніми фреймами Express. Це безкоштовна розвідка для атакувальника:
структура проєкту, версії, шляхи.

Виправлено: обробник помилок під `/api` логує помилку в консоль і віддає
`{"error":"internal error"}` зі статусом 500. Є тест, який перевіряє, що у
відповіді немає `SqliteError`, `at Layer` чи `node_modules`.

---

## Підсумкова перевірка (на живому сервері, після правки)

```
GET  /api/notes/3 as Оля (was the leak) -> {"error":"not found"} HTTP 404
GET  /api/notes/3 as Тарас (owner)      -> HTTP 200
GET  /api/notes   as ghost user 999     -> {"error":"not authenticated"} HTTP 401
POST /api/notes   as ghost user 999     -> {"error":"not authenticated"} HTTP 401
GET  /api/notes/1 as Оля (own note)     -> {"id":1,...,"archived":false} HTTP 200
```

Жоден маршрут більше не бере межу даних з `id` в URL.


