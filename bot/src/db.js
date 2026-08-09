import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { env } from './config.js'

mkdirSync(dirname(env.DB_PATH), { recursive: true })

export const db = new DatabaseSync(env.DB_PATH)
db.exec('PRAGMA journal_mode = WAL')
db.exec('PRAGMA foreign_keys = ON')

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY,
  username   TEXT,
  first_name TEXT,
  is_blocked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  user_id    INTEGER PRIMARY KEY,
  state      TEXT NOT NULL,
  draft      TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  public_no       TEXT UNIQUE,
  user_id         INTEGER NOT NULL,
  username        TEXT,
  item_id         TEXT NOT NULL,
  item_title      TEXT NOT NULL,
  amount          INTEGER NOT NULL,
  channel_id      TEXT NOT NULL,
  channel_title   TEXT NOT NULL,
  currency        TEXT NOT NULL,
  price           INTEGER NOT NULL,
  player_id       TEXT NOT NULL,
  status          TEXT NOT NULL,
  operator_note   TEXT,
  created_at      TEXT NOT NULL,
  paid_claimed_at TEXT,
  closed_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_status  ON orders(status, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_user    ON orders(user_id, created_at);

CREATE TABLE IF NOT EXISTS reviews (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id     INTEGER NOT NULL UNIQUE REFERENCES orders(id),
  user_id      INTEGER NOT NULL,
  username     TEXT,
  first_name   TEXT,
  rating       INTEGER NOT NULL,
  text         TEXT,
  status       TEXT NOT NULL DEFAULT 'new',
  created_at   TEXT NOT NULL,
  published_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_reviews_status ON reviews(status, id);

CREATE TABLE IF NOT EXISTS order_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    INTEGER NOT NULL REFERENCES orders(id),
  from_status TEXT,
  to_status   TEXT NOT NULL,
  actor       TEXT NOT NULL,
  comment     TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_order ON order_events(order_id, id);
`)

/** Добавляет колонку, если её ещё нет — чтобы старая база обновлялась без ручных миграций. */
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all()
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }
}

ensureColumn('users', 'source', 'TEXT')
ensureColumn('orders', 'source', 'TEXT')
ensureColumn('orders', 'nickname', 'TEXT')

const now = () => new Date().toISOString()

/* ---------- настройки ---------- */

const qGetSetting = db.prepare('SELECT value FROM settings WHERE key = ?')
const qSetSetting = db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
)

export const getSetting = key => qGetSetting.get(key)?.value ?? null
export const setSetting = (key, value) => qSetSetting.run(key, String(value))

/* ---------- пользователи ---------- */

const qUpsertUser = db.prepare(`
  INSERT INTO users (id, username, first_name, source, created_at) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    username = excluded.username,
    first_name = excluded.first_name,
    -- источник запоминается только первый раз: важно, откуда человек пришёл изначально
    source = COALESCE(users.source, excluded.source)
`)
const qGetUser = db.prepare('SELECT * FROM users WHERE id = ?')
const qSetBlocked = db.prepare('UPDATE users SET is_blocked = ? WHERE id = ?')

export const upsertUser = (from, source = null) =>
  qUpsertUser.run(from.id, from.username ?? null, from.first_name ?? null, source, now())
export const getUser = id => qGetUser.get(id) ?? null
export const setBlocked = (id, blocked) => qSetBlocked.run(blocked ? 1 : 0, id)

/* ---------- сессии (шаг диалога) ---------- */

const qGetSession = db.prepare('SELECT * FROM sessions WHERE user_id = ?')
const qSetSession = db.prepare(`
  INSERT INTO sessions (user_id, state, draft, updated_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(user_id) DO UPDATE SET state = excluded.state, draft = excluded.draft, updated_at = excluded.updated_at
`)

export function getSession(userId) {
  const row = qGetSession.get(userId)
  if (!row) return { state: 'idle', draft: {} }
  let draft = {}
  try {
    draft = JSON.parse(row.draft)
  } catch {
    draft = {}
  }
  return { state: row.state, draft }
}

export const setSession = (userId, state, draft = {}) =>
  qSetSession.run(userId, state, JSON.stringify(draft), now())

export const clearSession = userId => setSession(userId, 'idle', {})

/* ---------- заказы ---------- */

/** Разрешённые переходы. Обратных переходов нет: закрытый заказ не открывается заново. */
const TRANSITIONS = {
  awaiting_payment: ['paid_claimed', 'cancelled', 'rejected', 'expired'],
  paid_claimed: ['in_progress', 'done', 'rejected'],
  in_progress: ['done', 'rejected'],
  done: [],
  rejected: [],
  cancelled: [],
  expired: [],
}

const CLOSED = ['done', 'rejected', 'cancelled', 'expired']

export const STATUS_LABEL = {
  awaiting_payment: 'ждём оплату',
  paid_claimed: 'оплата заявлена',
  in_progress: 'в работе',
  done: 'выдано',
  rejected: 'отклонён',
  cancelled: 'отменён',
  expired: 'просрочен',
}

export const OPEN_STATUSES = ['awaiting_payment', 'paid_claimed', 'in_progress']

const qInsertOrder = db.prepare(`
  INSERT INTO orders (user_id, username, item_id, item_title, amount, channel_id, channel_title,
                      currency, price, player_id, nickname, source, status, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_payment', ?)
`)
const qSetPublicNo = db.prepare('UPDATE orders SET public_no = ? WHERE id = ?')
const qGetOrder = db.prepare('SELECT * FROM orders WHERE id = ?')
const qInsertEvent = db.prepare(
  'INSERT INTO order_events (order_id, from_status, to_status, actor, comment, created_at) VALUES (?, ?, ?, ?, ?, ?)'
)
const qOpenOrders = db.prepare(`
  SELECT * FROM orders WHERE status IN ('awaiting_payment','paid_claimed','in_progress')
  ORDER BY created_at ASC LIMIT ?
`)
const qRecentByUser = db.prepare(
  "SELECT COUNT(*) AS n FROM orders WHERE user_id = ? AND created_at > datetime('now', '-1 hour')"
)
const qLastOpenByUser = db.prepare(`
  SELECT * FROM orders WHERE user_id = ? AND status IN ('awaiting_payment','paid_claimed','in_progress')
  ORDER BY id DESC LIMIT 1
`)
const qStats = db.prepare(`
  SELECT status, COUNT(*) AS n, COALESCE(SUM(price), 0) AS total, currency
  FROM orders WHERE created_at > datetime('now', ?) GROUP BY status, currency
`)

export function createOrder(data) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const res = qInsertOrder.run(
      data.user_id,
      data.username ?? null,
      data.item_id,
      data.item_title,
      data.amount,
      data.channel_id,
      data.channel_title,
      data.currency,
      data.price,
      data.player_id,
      data.nickname ?? null,
      data.source ?? null,
      now()
    )
    const id = Number(res.lastInsertRowid)
    const publicNo = 'SO2-' + String(id).padStart(4, '0')
    qSetPublicNo.run(publicNo, id)
    qInsertEvent.run(id, null, 'awaiting_payment', `user:${data.user_id}`, null, now())
    db.exec('COMMIT')
    return qGetOrder.get(id)
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

/**
 * Меняет статус заказа, только если текущий статус — ожидаемый и переход разрешён.
 * Возвращает { ok, order, reason }. Защищает от двойного нажатия кнопки.
 */
export function transition(orderId, toStatus, actor, comment = null) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const order = qGetOrder.get(orderId)
    if (!order) {
      db.exec('ROLLBACK')
      return { ok: false, reason: 'not_found' }
    }
    const allowed = TRANSITIONS[order.status] ?? []
    if (!allowed.includes(toStatus)) {
      db.exec('ROLLBACK')
      return { ok: false, order, reason: 'forbidden' }
    }

    const closed = CLOSED.includes(toStatus)
    db.prepare(
      `UPDATE orders SET status = ?, operator_note = COALESCE(?, operator_note),
         paid_claimed_at = CASE WHEN ? = 'paid_claimed' THEN ? ELSE paid_claimed_at END,
         closed_at = CASE WHEN ? THEN ? ELSE closed_at END
       WHERE id = ? AND status = ?`
    ).run(toStatus, comment, toStatus, now(), closed ? 1 : 0, now(), orderId, order.status)

    qInsertEvent.run(orderId, order.status, toStatus, actor, comment, now())
    db.exec('COMMIT')
    return { ok: true, order: qGetOrder.get(orderId), from: order.status }
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

export const getOrder = id => qGetOrder.get(id) ?? null
export const openOrders = (limit = 20) => qOpenOrders.all(limit)
export const ordersLastHour = userId => qRecentByUser.get(userId).n
export const lastOpenOrder = userId => qLastOpenByUser.get(userId) ?? null
export const statsSince = interval => qStats.all(interval)

/** Последний использованный игровой ID покупателя — для повтора заказа в один тап. */
const qLastIdentity = db.prepare(`
  SELECT player_id, nickname FROM orders
  WHERE user_id = ? AND player_id IS NOT NULL ORDER BY id DESC LIMIT 1
`)
export const lastIdentity = userId => qLastIdentity.get(userId) ?? null

/** Брошенные неоплаченные заказы старше N часов закрываем, чтобы не мусорили в очереди. */
const qStale = db.prepare(
  "SELECT id FROM orders WHERE status = 'awaiting_payment' AND created_at < datetime('now', ?)"
)
export function expireStaleOrders(hours = 24) {
  const rows = qStale.all(`-${hours} hours`)
  for (const r of rows) transition(r.id, 'expired', 'system', `не оплачен за ${hours} ч`)
  return rows.length
}

/* ---------- отзывы ---------- */

const qCreateReview = db.prepare(`
  INSERT INTO reviews (order_id, user_id, username, first_name, rating, created_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(order_id) DO UPDATE SET rating = excluded.rating
`)
const qReviewByOrder = db.prepare('SELECT * FROM reviews WHERE order_id = ?')
const qReviewById = db.prepare('SELECT * FROM reviews WHERE id = ?')
const qSetReviewText = db.prepare('UPDATE reviews SET text = ? WHERE id = ?')
const qSetReviewStatus = db.prepare(
  "UPDATE reviews SET status = ?, published_at = CASE WHEN ? = 'published' THEN ? ELSE published_at END WHERE id = ?"
)
const qReviewStats = db.prepare(
  "SELECT COUNT(*) AS n, ROUND(AVG(rating), 1) AS avg FROM reviews WHERE status != 'hidden'"
)

export function createReview(order, from, rating) {
  qCreateReview.run(order.id, from.id, from.username ?? null, from.first_name ?? null, rating, now())
  return qReviewByOrder.get(order.id)
}
export const reviewByOrder = orderId => qReviewByOrder.get(orderId) ?? null
export const reviewById = id => qReviewById.get(id) ?? null
export const setReviewText = (id, text) => qSetReviewText.run(text, id)
export const setReviewStatus = (id, status) => qSetReviewStatus.run(status, status, now(), id)
export const reviewStats = () => qReviewStats.get()

const qSourceStats = db.prepare(`
  SELECT COALESCE(source, 'без метки') AS source, COUNT(*) AS n,
         SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done
  FROM orders WHERE created_at > datetime('now', ?) GROUP BY 1 ORDER BY n DESC
`)
export const sourceStatsSince = interval => qSourceStats.all(interval)
export const orderEvents = orderId =>
  db.prepare('SELECT * FROM order_events WHERE order_id = ? ORDER BY id').all(orderId)
