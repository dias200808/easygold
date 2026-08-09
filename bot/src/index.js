import { Bot, InlineKeyboard, GrammyError, HttpError } from 'grammy'
import { config, env, channels, items, priceOf, refPriceOf, isWorkingHours } from './config.js'
import * as store from './db.js'

const bot = new Bot(env.BOT_TOKEN)

/* ---------------------------------------------------------------- утилиты */

const esc = s =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const money = (value, symbol) => `${value.toLocaleString('ru-RU')} ${symbol}`

const idRe = new RegExp(config.game.id_regex)

/** Сколько заказ уже ждёт — оператору важнее всего именно это. */
function ageOf(iso) {
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000))
  if (min < 60) return `${min} мин`
  const h = Math.floor(min / 60)
  return `${h} ч ${min % 60} мин`
}

function adminChatId() {
  const stored = store.getSetting('admin_chat_id')
  return stored ? Number(stored) : env.ADMIN_CHAT_ID
}

function isAdmin(ctx) {
  const stored = store.getSetting('admin_user_id')
  if (stored && ctx.from?.id === Number(stored)) return true
  if (env.ADMIN_CHAT_ID && ctx.chat?.id === env.ADMIN_CHAT_ID) return true
  return false
}

/**
 * Привязывает оператора при ПЕРВОМ обращении с нужного юзернейма.
 * Дальше привязка держится на числовом id и по юзернейму больше не меняется:
 * юзернейм в Telegram можно освободить и занять заново, id — нельзя.
 */
function maybeLinkAdmin(ctx) {
  const uname = ctx.from?.username?.toLowerCase()
  if (!uname || !env.ADMIN_USERNAME || uname !== env.ADMIN_USERNAME) return false

  const known = store.getSetting('admin_user_id')
  if (known) {
    if (Number(known) !== ctx.from.id) {
      notifyAdmin(
        `🚨 <b>Попытка перехвата доступа</b>\n\n` +
          `Кто-то с юзернеймом @${esc(uname)} (id <code>${ctx.from.id}</code>) пытался привязаться как оператор.\n` +
          `Запрос отклонён — оператор остался прежним.`
      )
    }
    return false
  }

  store.setSetting('admin_user_id', ctx.from.id)
  store.setSetting('admin_chat_id', ctx.chat?.id ?? ctx.from.id)
  return true
}

async function notifyAdmin(text, keyboard) {
  const chatId = adminChatId()
  if (!chatId) {
    console.warn('[!] Оператор не привязан — уведомление не отправлено:\n' + text)
    return
  }
  try {
    await bot.api.sendMessage(chatId, text, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
      link_preview_options: { is_disabled: true },
    })
  } catch (e) {
    console.error('Не смог написать оператору:', e.message)
  }
}

async function notifyCustomer(userId, text, keyboard) {
  try {
    await bot.api.sendMessage(userId, text, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
      link_preview_options: { is_disabled: true },
    })
  } catch (e) {
    // Пользователь мог заблокировать бота — это не повод падать
    console.error(`Не смог написать покупателю ${userId}:`, e.message)
  }
}

function orderCard(o, { forAdmin }) {
  const ch = channels.get(o.channel_id)
  const symbol = ch?.symbol ?? o.currency
  const lines = [
    `<b>Заказ ${esc(o.public_no)}</b>`,
    `Товар: ${esc(o.item_title)} — ${esc(config.game.title)}`,
    `Игровой ID: <code>${esc(o.player_id)}</code>`,
  ]
  if (o.nickname) lines.push(`Ник: <b>${esc(o.nickname)}</b>`)
  lines.push(
    `Сумма: <b>${money(o.price, symbol)}</b>`,
    `Статус: <b>${store.STATUS_LABEL[o.status] ?? o.status}</b>`
  )
  if (forAdmin) {
    const who = o.username ? `@${esc(o.username)}` : `id ${o.user_id}`
    lines.push(`Покупатель: ${who}`, `Ждёт: ${ageOf(o.created_at)}`)
    if (o.source) lines.push(`Источник: ${esc(o.source)}`)
    if (!['done', 'rejected', 'cancelled', 'expired'].includes(o.status) && o.nickname) {
      lines.push('', '⚠️ Найдите ID в магазине и сверьте ник — только потом выдавайте.')
    }
  }
  if (o.operator_note) lines.push(`Комментарий: ${esc(o.operator_note)}`)
  return lines.join('\n')
}

function adminKeyboard(o) {
  const kb = new InlineKeyboard()
  const open = !['done', 'rejected', 'cancelled', 'expired'].includes(o.status)
  if (open && config.game.store_url) kb.url('🔍 Открыть магазин', config.game.store_url).row()
  if (o.status === 'paid_claimed') kb.text('🔧 В работе', `op:progress:${o.id}`).row()
  if (o.status === 'paid_claimed' || o.status === 'in_progress') {
    kb.text('✅ Выполнено', `op:done:${o.id}`).row()
  }
  if (open) kb.text('❌ Отклонить', `op:reject:${o.id}`)
  return kb
}

/* ------------------------------------------------------------ экран старта */

/** Если способ оплаты один, экран выбора не показываем — это лишний тап на пути к оплате. */
const soleChannel = channels.size === 1 ? [...channels.values()][0] : null

function channelKeyboard() {
  const kb = new InlineKeyboard()
  for (const c of config.channels) kb.text(c.title, `ch:${c.id}`).row()
  return kb
}

function itemKeyboard(ch, withBack) {
  const kb = new InlineKeyboard()
  for (const item of config.items) {
    const label = `${item.popular ? '⭐ ' : ''}${item.title} — ${money(priceOf(item, ch.currency), ch.symbol)}`
    kb.text(label, `it:${item.id}`).row()
  }
  if (withBack) kb.text('« Назад', 'back:start')
  return kb
}

function priceRows(ch) {
  return config.items.map(item => {
    const price = priceOf(item, ch.currency)
    const ref = refPriceOf(item, ch.currency)
    const save = ref && ref > price ? ` <i>(в игре ${money(ref, ch.symbol)})</i>` : ''
    return `• ${esc(item.title)} — <b>${money(price, ch.symbol)}</b>${save}`
  })
}

function nightNote() {
  if (isWorkingHours()) return null
  const { from, timezone_note } = config.working_hours
  return `\n🌙 Сейчас нерабочее время. Заказ примем, выдадим после ${from}:00 (${timezone_note}).`
}

/** Реквизиты по заказу — показываем и при оформлении, и потом по /myorder. */
function paymentInstructions(order) {
  const ch = channels.get(order.channel_id)
  if (!ch?.instructions) return null
  return ch.instructions
    .replaceAll('{price}', order.price.toLocaleString('ru-RU'))
    .replaceAll('{order_no}', order.public_no)
}

function payKeyboard(order) {
  return new InlineKeyboard()
    .text('💸 Я оплатил', `paid:${order.id}`)
    .row()
    .text('❌ Отменить заказ', `cancel:${order.id}`)
}

/** Экран «проверьте заказ» — общий для обычного пути и для повтора прошлого ID. */
function confirmView(draft) {
  const ch = channels.get(draft.channel_id)
  const item = items.get(draft.item_id)
  if (!ch || !item || !draft.player_id || !draft.nickname) return null
  const kb = new InlineKeyboard()
    .text('✅ Всё верно, оформить', 'confirm')
    .row()
    .text('❌ Отмена', 'back:start')
  const text = [
    '<b>Проверьте заказ</b>',
    '',
    `Товар: ${esc(item.title)} — ${esc(config.game.title)}`,
    `Игровой ID: <code>${esc(draft.player_id)}</code>`,
    `Ник: <b>${esc(draft.nickname)}</b>`,
    `К оплате: <b>${money(priceOf(item, ch.currency), ch.symbol)}</b>`,
    '',
    esc(config.texts.footer_warning),
    '',
    '<i>Оформляя заказ, вы подтверждаете, что вам есть 18 лет либо покупка одобрена родителями.</i>',
  ].join('\n')
  return { text, kb }
}

/** Первый экран. При одном канале сразу показывает номиналы. */
function withReviewsLink(kb) {
  const url = config.brand?.reviews_channel_url
  if (url) kb.row().url('⭐ Отзывы покупателей', url)
  return kb
}

function startView() {
  const parts = [config.texts.welcome, nightNote()].filter(Boolean)
  if (soleChannel) {
    return {
      text: [...parts, '', ...priceRows(soleChannel), '', 'Выберите номинал:'].join('\n'),
      keyboard: withReviewsLink(itemKeyboard(soleChannel, false)),
      channel: soleChannel,
    }
  }
  return {
    text: [...parts, '\nОткуда будете оплачивать?'].join('\n'),
    keyboard: withReviewsLink(channelKeyboard()),
    channel: null,
  }
}

/* -------------------------------------------------------------- обработчики */

bot.command('start', async ctx => {
  // t.me/EasyGoldBot?start=tiktok → source = "tiktok". Запоминается только при первом заходе.
  const source = (ctx.match || '').trim().slice(0, 32) || null
  store.upsertUser(ctx.from, source)
  if (maybeLinkAdmin(ctx)) {
    await ctx.reply(
      '✅ Вы привязаны как оператор. Заказы будут приходить сюда.\n\n' +
        '/orders — открытые заказы\n/stats — статистика\n/whoami — ваш chat id'
    )
    return
  }
  const view = startView()
  store.setSession(ctx.from.id, view.channel ? 'choosing_item' : 'idle',
    view.channel ? { channel_id: view.channel.id } : {})
  await ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: view.keyboard })
})

bot.command('whoami', async ctx => {
  maybeLinkAdmin(ctx)
  await ctx.reply(`chat_id: <code>${ctx.chat.id}</code>\nuser_id: <code>${ctx.from.id}</code>`, {
    parse_mode: 'HTML',
  })
})

bot.command('cancel', async ctx => {
  store.clearSession(ctx.from.id)
  const open = store.lastOpenOrder(ctx.from.id)
  if (open && open.status === 'awaiting_payment') {
    store.transition(open.id, 'cancelled', `user:${ctx.from.id}`, 'отменён покупателем')
    await ctx.reply(`Заказ ${open.public_no} отменён.`)
  } else {
    await ctx.reply('Отменил. /start — начать заново.')
  }
})

bot.command('myorder', async ctx => {
  const o = store.lastOpenOrder(ctx.from.id)
  if (!o) return ctx.reply('Открытых заказов нет. /start — оформить новый.')

  // Если заказ ещё не оплачен — повторяем реквизиты, чтобы их не искать в переписке
  if (o.status === 'awaiting_payment') {
    const instructions = paymentInstructions(o)
    return ctx.reply(
      [orderCard(o, { forAdmin: false }), '', '— — —', '', instructions].filter(Boolean).join('\n'),
      { parse_mode: 'HTML', reply_markup: payKeyboard(o) }
    )
  }
  await ctx.reply(orderCard(o, { forAdmin: false }), { parse_mode: 'HTML' })
})

/* --- команды оператора --- */

bot.command('orders', async ctx => {
  maybeLinkAdmin(ctx)
  if (!isAdmin(ctx)) return
  const expired = store.expireStaleOrders(24) // брошенные неоплаченные не должны копиться в очереди
  const list = store.openOrders(20)
  if (!list.length) {
    return ctx.reply(expired ? `Открытых заказов нет. Просрочено и закрыто: ${expired}.` : 'Открытых заказов нет.')
  }
  for (const o of list) {
    await ctx.reply(orderCard(o, { forAdmin: true }), {
      parse_mode: 'HTML',
      reply_markup: adminKeyboard(o),
    })
  }
})

bot.command('stats', async ctx => {
  maybeLinkAdmin(ctx)
  if (!isAdmin(ctx)) return
  const render = (title, rows) => {
    if (!rows.length) return `${title}: нет заказов`
    const byStatus = rows.map(
      r => `  ${store.STATUS_LABEL[r.status] ?? r.status}: ${r.n} шт · ${r.total} ${r.currency}`
    )
    return `${title}:\n${byStatus.join('\n')}`
  }
  const sources = store.sourceStatsSince('-7 days')
  const srcBlock = sources.length
    ? 'Источники за 7 дней:\n' + sources.map(s => `  ${s.source}: ${s.n} заказов, выдано ${s.done}`).join('\n')
    : ''

  const rv = store.reviewStats()
  const rvBlock = rv?.n ? `Отзывы: ${rv.avg} ★ из ${rv.n}` : 'Отзывов пока нет'

  await ctx.reply(
    [
      render('За сутки', store.statsSince('-1 day')),
      '',
      render('За 7 дней', store.statsSince('-7 days')),
      '',
      rvBlock,
      '',
      srcBlock,
    ]
      .filter(Boolean)
      .join('\n')
  )
})

/* --- выбор канала оплаты --- */

bot.callbackQuery(/^ch:(.+)$/, async ctx => {
  const ch = channels.get(ctx.match[1])
  if (!ch) return ctx.answerCallbackQuery({ text: 'Способ недоступен' })

  store.setSession(ctx.from.id, 'choosing_item', { channel_id: ch.id })

  await ctx.editMessageText(
    [`<b>${esc(config.game.title)}</b> · ${esc(ch.title)}`, '', ...priceRows(ch), '', 'Выберите номинал:'].join('\n'),
    { parse_mode: 'HTML', reply_markup: itemKeyboard(ch, true) }
  )
  await ctx.answerCallbackQuery()
})

bot.callbackQuery('back:start', async ctx => {
  const view = startView()
  store.setSession(ctx.from.id, view.channel ? 'choosing_item' : 'idle',
    view.channel ? { channel_id: view.channel.id } : {})
  await ctx.editMessageText(view.text, { parse_mode: 'HTML', reply_markup: view.keyboard })
  await ctx.answerCallbackQuery()
})

/* --- выбор номинала --- */

bot.callbackQuery(/^it:(.+)$/, async ctx => {
  const { draft } = store.getSession(ctx.from.id)
  const ch = channels.get(draft.channel_id)
  const item = items.get(ctx.match[1])
  if (!ch || !item) return ctx.answerCallbackQuery({ text: 'Начните заново: /start' })

  store.setSession(ctx.from.id, 'awaiting_id', { ...draft, item_id: item.id })

  // Донат покупают повторно — второй заказ должен занимать два тапа, а не четыре.
  const last = store.lastIdentity(ctx.from.id)
  const kb = new InlineKeyboard()
  if (last?.player_id && last?.nickname) {
    kb.text(`↩️ ${last.nickname} · ${last.player_id}`, 'reuse').row()
  }

  await ctx.editMessageText(
    [
      `${esc(item.title)} — <b>${money(priceOf(item, ch.currency), ch.symbol)}</b>`,
      '',
      `Пришлите ваш <b>${esc(config.game.id_label)}</b>.`,
      '',
      `<i>${esc(config.game.id_hint)}</i>`,
      '',
      esc(config.texts.footer_warning),
    ].join('\n'),
    { parse_mode: 'HTML', reply_markup: kb.inline_keyboard.length ? kb : undefined }
  )
  await ctx.answerCallbackQuery()
})

/** Повтор прошлого ID: сразу на экран подтверждения. */
bot.callbackQuery('reuse', async ctx => {
  const { draft } = store.getSession(ctx.from.id)
  const last = store.lastIdentity(ctx.from.id)
  if (!last?.player_id || !draft.item_id) {
    return ctx.answerCallbackQuery({ text: 'Начните заново: /start', show_alert: true })
  }
  const next = { ...draft, player_id: last.player_id, nickname: last.nickname }
  const view = confirmView(next)
  if (!view) return ctx.answerCallbackQuery({ text: 'Начните заново: /start', show_alert: true })

  store.setSession(ctx.from.id, 'awaiting_confirm', next)
  await ctx.editMessageText(view.text, { parse_mode: 'HTML', reply_markup: view.kb })
  await ctx.answerCallbackQuery()
})

/* --- ввод и повтор игрового ID --- */

bot.on('message:text', async ctx => {
  store.upsertUser(ctx.from)
  maybeLinkAdmin(ctx)

  const { state, draft } = store.getSession(ctx.from.id)
  const text = ctx.message.text.trim()

  // Оператор вводит причину отклонения
  if (state === 'admin_reject_reason' && isAdmin(ctx)) {
    const res = store.transition(draft.order_id, 'rejected', `operator:${ctx.from.id}`, text)
    store.clearSession(ctx.from.id)
    if (!res.ok) return ctx.reply('Заказ уже закрыт.')
    await ctx.reply(`Заказ ${res.order.public_no} отклонён.`)
    await notifyCustomer(
      res.order.user_id,
      `Заказ <b>${esc(res.order.public_no)}</b> отклонён.\nПричина: ${esc(text)}\n\n` +
        `Если вы уже оплатили — напишите оператору, вернём деньги.`
    )
    return
  }

  // Текст отзыва
  if (state === 'awaiting_review_text') {
    const review = store.reviewById(draft.review_id)
    store.clearSession(ctx.from.id)
    if (!review || review.user_id !== ctx.from.id) return ctx.reply('Отзыв не найден.')
    store.setReviewText(review.id, text.slice(0, 500))
    await ctx.reply('Спасибо! Отзыв отправлен на модерацию.', {
      reply_markup: new InlineKeyboard().text('🔁 Купить ещё', 'back:start'),
    })
    return sendReviewToAdmin(store.reviewById(review.id))
  }

  if (state === 'awaiting_id') {
    if (!idRe.test(text)) {
      return ctx.reply(
        `Не похоже на ${esc(config.game.id_label)}. Проверьте и пришлите ещё раз.\n\n<i>${esc(config.game.id_hint)}</i>`,
        { parse_mode: 'HTML' }
      )
    }
    store.setSession(ctx.from.id, 'awaiting_nickname', { ...draft, player_id: text })
    return ctx.reply(
      'Теперь пришлите <b>ваш ник в игре</b> — точно как в профиле.\n\n' +
        'По нику мы проверим, что голда уйдёт именно вам, а не однокласснику с похожим ID.',
      { parse_mode: 'HTML' }
    )
  }

  if (state === 'awaiting_nickname') {
    if (text.length < 2 || text.length > 24) {
      return ctx.reply('Ник должен быть от 2 до 24 символов. Пришлите ещё раз.')
    }
    if (text === draft.player_id) {
      return ctx.reply('Это ID, а не ник. Ник написан в профиле над цифрами — пришлите его.')
    }

    const next = { ...draft, nickname: text }
    const view = confirmView(next)
    if (!view) {
      store.clearSession(ctx.from.id)
      return ctx.reply('Что-то потерялось. Начните заново: /start')
    }

    store.setSession(ctx.from.id, 'awaiting_confirm', next)
    return ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: view.kb })
  }

  // Свободное сообщение вне диалога — пересылаем оператору как обращение
  if (!isAdmin(ctx)) {
    const open = store.lastOpenOrder(ctx.from.id)
    const ref = open ? ` (заказ ${open.public_no})` : ''
    const who = ctx.from.username ? `@${esc(ctx.from.username)}` : `id ${ctx.from.id}`
    await notifyAdmin(`💬 Сообщение от ${who}${esc(ref)}:\n\n${esc(text)}`)
    await ctx.reply('Передал оператору. Ответит здесь же.\n\n/start — оформить заказ')
  }
})

/* --- скриншот оплаты --- */

bot.on('message:photo', async ctx => {
  store.upsertUser(ctx.from)

  // Оператор прислал картинку для поста с отзывом
  if (isAdmin(ctx)) {
    const { state, draft } = store.getSession(ctx.from.id)
    if (state !== 'awaiting_review_photo') return
    const review = store.reviewById(draft.review_id)
    store.clearSession(ctx.from.id)
    if (!review) return ctx.reply('Отзыв не найден.')
    const fileId = ctx.message.photo.at(-1).file_id // самый крупный размер
    try {
      await publishReview(review, fileId)
    } catch (e) {
      return ctx.reply('Не отправилось: ' + e.message)
    }
    return ctx.reply('✅ Опубликовано с фото.')
  }

  const open = store.lastOpenOrder(ctx.from.id)
  const who = ctx.from.username ? `@${ctx.from.username}` : `id ${ctx.from.id}`
  const chatId = adminChatId()
  if (chatId) {
    try {
      await ctx.api.forwardMessage(chatId, ctx.chat.id, ctx.message.message_id)
      await bot.api.sendMessage(
        chatId,
        `↑ скриншот от ${who}${open ? ` по заказу ${open.public_no}` : ''}`
      )
    } catch (e) {
      console.error('Не переслал скриншот:', e.message)
    }
  }
  await ctx.reply('Скриншот передал оператору.')
})

/* --- подтверждение заказа --- */

bot.callbackQuery('confirm', async ctx => {
  const { draft } = store.getSession(ctx.from.id)
  const ch = channels.get(draft.channel_id)
  const item = items.get(draft.item_id)
  if (!ch || !item || !draft.player_id || !draft.nickname) {
    return ctx.answerCallbackQuery({ text: 'Начните заново: /start', show_alert: true })
  }

  const user = store.getUser(ctx.from.id)
  if (user?.is_blocked) {
    return ctx.answerCallbackQuery({ text: 'Оформление недоступно.', show_alert: true })
  }
  if (store.ordersLastHour(ctx.from.id) >= env.MAX_ORDERS_PER_HOUR) {
    return ctx.answerCallbackQuery({
      text: 'Слишком много заказов за час. Напишите оператору.',
      show_alert: true,
    })
  }

  const price = priceOf(item, ch.currency)
  const order = store.createOrder({
    user_id: ctx.from.id,
    username: ctx.from.username ?? null,
    item_id: item.id,
    item_title: item.title,
    amount: item.amount,
    channel_id: ch.id,
    channel_title: ch.title,
    currency: ch.currency,
    price,
    player_id: draft.player_id,
    nickname: draft.nickname,
    source: user?.source ?? null,
  })
  store.clearSession(ctx.from.id)

  await ctx.editMessageText(
    [orderCard(order, { forAdmin: false }), '', '— — —', '', paymentInstructions(order)]
      .filter(Boolean)
      .join('\n'),
    { parse_mode: 'HTML', reply_markup: payKeyboard(order) }
  )
  await ctx.answerCallbackQuery()

  if (ch.notify_on_create) {
    await notifyAdmin(
      `🕓 Новый заказ, ждёт оплату — нужно прислать реквизиты\n\n${orderCard(order, { forAdmin: true })}`
    )
  }
})

/* --- покупатель заявил оплату --- */

bot.callbackQuery(/^paid:(\d+)$/, async ctx => {
  const orderId = Number(ctx.match[1])
  const existing = store.getOrder(orderId)
  if (!existing || existing.user_id !== ctx.from.id) {
    return ctx.answerCallbackQuery({ text: 'Заказ не найден', show_alert: true })
  }

  const res = store.transition(orderId, 'paid_claimed', `user:${ctx.from.id}`)
  if (!res.ok) {
    return ctx.answerCallbackQuery({ text: 'Уже отмечено, оператор в курсе.' })
  }

  await ctx.editMessageText(
    [orderCard(res.order, { forAdmin: false }), '', config.texts.after_order].join('\n'),
    { parse_mode: 'HTML' }
  )
  await ctx.answerCallbackQuery({ text: 'Передал оператору' })

  await notifyAdmin(
    `💸 <b>ОПЛАТА ЗАЯВЛЕНА</b> — проверьте поступление\n\n${orderCard(res.order, { forAdmin: true })}`,
    adminKeyboard(res.order)
  )
})

/* --- покупатель отменил --- */

bot.callbackQuery(/^cancel:(\d+)$/, async ctx => {
  const orderId = Number(ctx.match[1])
  const existing = store.getOrder(orderId)
  if (!existing || existing.user_id !== ctx.from.id) {
    return ctx.answerCallbackQuery({ text: 'Заказ не найден', show_alert: true })
  }
  const res = store.transition(orderId, 'cancelled', `user:${ctx.from.id}`, 'отменён покупателем')
  if (!res.ok) return ctx.answerCallbackQuery({ text: 'Заказ уже закрыт.' })
  await ctx.editMessageText(`Заказ ${esc(res.order.public_no)} отменён.\n\n/start — оформить новый`, {
    parse_mode: 'HTML',
  })
  await ctx.answerCallbackQuery()
})

/* --- действия оператора --- */

bot.callbackQuery(/^op:(progress|done|reject):(\d+)$/, async ctx => {
  if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'Недоступно', show_alert: true })

  const action = ctx.match[1]
  const orderId = Number(ctx.match[2])

  if (action === 'reject') {
    store.setSession(ctx.from.id, 'admin_reject_reason', { order_id: orderId })
    await ctx.answerCallbackQuery()
    return ctx.reply(`Напишите причину отклонения заказа #${orderId} одним сообщением.`)
  }

  const toStatus = action === 'progress' ? 'in_progress' : 'done'
  const res = store.transition(orderId, toStatus, `operator:${ctx.from.id}`)
  if (!res.ok) {
    return ctx.answerCallbackQuery({
      text: res.reason === 'forbidden' ? 'Статус уже изменён' : 'Заказ не найден',
      show_alert: true,
    })
  }

  await ctx.editMessageText(orderCard(res.order, { forAdmin: true }), {
    parse_mode: 'HTML',
    reply_markup: adminKeyboard(res.order),
  })
  await ctx.answerCallbackQuery({ text: toStatus === 'done' ? 'Выдано' : 'Взято в работу' })

  if (toStatus === 'in_progress') {
    await notifyCustomer(
      res.order.user_id,
      `🔧 Заказ <b>${esc(res.order.public_no)}</b> взят в работу. Голда придёт в течение нескольких минут.`
    )
  } else {
    const kb = new InlineKeyboard()
      .text('⭐ Оставить отзыв', `rev:${res.order.id}`)
      .row()
      .text('🔁 Купить ещё', 'back:start')
    await notifyCustomer(
      res.order.user_id,
      [
        `✅ Заказ <b>${esc(res.order.public_no)}</b> выполнен.`,
        `${esc(res.order.item_title)} зачислено на ID <code>${esc(res.order.player_id)}</code>.`,
        '',
        'Если голда не пришла — напишите сюда, разберёмся.',
      ].join('\n'),
      kb
    )
  }
})

/* ------------------------------------------------------------------ отзывы */

const stars = n => '⭐'.repeat(n)

/** Скорость выдачи — самый убедительный факт в отзыве. */
function deliverySpeed(o) {
  const start = o.paid_claimed_at || o.created_at
  if (!start || !o.closed_at) return null
  const min = Math.max(1, Math.round((new Date(o.closed_at) - new Date(start)) / 60000))
  return `${min} мин`
}

/** Текст ровно в том виде, в каком он уйдёт в канал. */
function channelPost(review) {
  const o = store.getOrder(review.order_id)
  const speed = o ? deliverySpeed(o) : null
  return [
    stars(review.rating),
    review.text ? `\n«${esc(review.text)}»\n` : '',
    `${esc(o?.item_title ?? '')} — ${esc(config.game.title)}${speed ? ` · выдано за ${speed}` : ''}`,
    review.first_name ? `— ${esc(review.first_name)}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

async function sendReviewToAdmin(review) {
  const o = store.getOrder(review.order_id)
  const who = review.username ? `@${esc(review.username)}` : esc(review.first_name || 'покупатель')
  const kb = new InlineKeyboard()
    .text('✅ В канал', `rv:pub:${review.id}`)
    .text('📷 С фото', `rv:photo:${review.id}`)
    .row()
    .text('🗑 Скрыть', `rv:hide:${review.id}`)
  const warn = review.rating <= 3 ? '\n⚠️ Низкая оценка — сначала свяжитесь с покупателем.' : ''

  await notifyAdmin(
    [
      '📝 <b>Новый отзыв.</b> Вот что уйдёт в канал:',
      '━━━━━━━━━━━━━━',
      channelPost(review),
      '━━━━━━━━━━━━━━',
      '',
      `<i>Не публикуется: заказ ${esc(o?.public_no ?? '')}, от ${who}</i>${warn}`,
    ].join('\n'),
    kb
  )
}

/** Публикация в канал: текстом или картинкой с подписью. */
async function publishReview(review, photoFileId = null) {
  if (!env.REVIEWS_CHANNEL_ID) throw new Error('Канал не настроен: добавьте REVIEWS_CHANNEL_ID в .env')
  const text = channelPost(review)
  if (photoFileId) {
    await bot.api.sendPhoto(env.REVIEWS_CHANNEL_ID, photoFileId, {
      caption: text,
      parse_mode: 'HTML',
    })
  } else {
    await bot.api.sendMessage(env.REVIEWS_CHANNEL_ID, text, { parse_mode: 'HTML' })
  }
  store.setReviewStatus(review.id, 'published')
}

/** Кнопка отзыва показывается один раз — после выдачи, на пике довольства. */
bot.callbackQuery(/^rev:(\d+)$/, async ctx => {
  const order = store.getOrder(Number(ctx.match[1]))
  if (!order || order.user_id !== ctx.from.id || order.status !== 'done') {
    return ctx.answerCallbackQuery({ text: 'Недоступно', show_alert: true })
  }
  if (store.reviewByOrder(order.id)) {
    return ctx.answerCallbackQuery({ text: 'Вы уже оставили отзыв. Спасибо!', show_alert: true })
  }
  const kb = new InlineKeyboard()
  for (let i = 5; i >= 1; i--) kb.text(`${stars(i)}`, `revr:${order.id}:${i}`).row()
  await ctx.reply('Как всё прошло?', { reply_markup: kb })
  await ctx.answerCallbackQuery()
})

bot.callbackQuery(/^revr:(\d+):([1-5])$/, async ctx => {
  const order = store.getOrder(Number(ctx.match[1]))
  const rating = Number(ctx.match[2])
  if (!order || order.user_id !== ctx.from.id || order.status !== 'done') {
    return ctx.answerCallbackQuery({ text: 'Недоступно', show_alert: true })
  }
  const review = store.createReview(order, ctx.from, rating)
  store.setSession(ctx.from.id, 'awaiting_review_text', { review_id: review.id })

  await ctx.editMessageText(
    `${stars(rating)}\n\nНапишите пару слов — это поможет другим решиться. Или пропустите.`,
    { reply_markup: new InlineKeyboard().text('Пропустить', `revskip:${review.id}`) }
  )
  await ctx.answerCallbackQuery('Спасибо!')
})

bot.callbackQuery(/^revskip:(\d+)$/, async ctx => {
  const review = store.reviewById(Number(ctx.match[1]))
  store.clearSession(ctx.from.id)
  if (!review || review.user_id !== ctx.from.id) return ctx.answerCallbackQuery()
  await ctx.editMessageText(`${stars(review.rating)}\n\nСпасибо за оценку!`, {
    reply_markup: new InlineKeyboard().text('🔁 Купить ещё', 'back:start'),
  })
  await ctx.answerCallbackQuery()
  await sendReviewToAdmin(review)
})

/* --- модерация отзывов оператором --- */

bot.callbackQuery(/^rv:(pub|hide|photo):(\d+)$/, async ctx => {
  if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'Недоступно', show_alert: true })
  const action = ctx.match[1]
  const review = store.reviewById(Number(ctx.match[2]))
  if (!review) return ctx.answerCallbackQuery({ text: 'Отзыв не найден', show_alert: true })

  if (action === 'hide') {
    store.setReviewStatus(review.id, 'hidden')
    await ctx.editMessageText(ctx.msg.text + '\n\n🗑 Скрыт, в канал не пойдёт')
    return ctx.answerCallbackQuery('Скрыт')
  }

  if (action === 'photo') {
    store.setSession(ctx.from.id, 'awaiting_review_photo', { review_id: review.id })
    await ctx.answerCallbackQuery()
    return ctx.reply(
      `Пришлите фото для отзыва ${stars(review.rating)} — опубликую его с этой подписью.\n\n/cancel — отменить.`
    )
  }

  try {
    await publishReview(review)
  } catch (e) {
    return ctx.answerCallbackQuery({ text: 'Не отправилось: ' + e.message, show_alert: true })
  }
  await ctx.editMessageText(ctx.msg.text + '\n\n✅ Опубликован')
  await ctx.answerCallbackQuery('Опубликован')
})

/* ------------------------------------------------------------------ запуск */

bot.catch(err => {
  const e = err.error
  if (e instanceof GrammyError) console.error('Ошибка Telegram API:', e.description)
  else if (e instanceof HttpError) console.error('Сеть недоступна:', e)
  else console.error('Ошибка:', e)
})

const stop = () => bot.stop()
process.once('SIGINT', stop)
process.once('SIGTERM', stop)

await bot.api.setMyCommands([
  { command: 'start', description: 'Купить голду' },
  { command: 'myorder', description: 'Мой заказ' },
  { command: 'cancel', description: 'Отменить' },
])

console.log('Бот запущен. Оператор: @' + (env.ADMIN_USERNAME || '—') + ', chat_id: ' + (adminChatId() ?? 'не привязан'))
bot.start()
