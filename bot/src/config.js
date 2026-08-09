import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

export const config = JSON.parse(readFileSync(resolve(root, 'config.json'), 'utf8'))

function required(name) {
  const v = process.env[name]
  if (!v) {
    console.error(`Не задана переменная окружения ${name}. Скопируйте .env.example в .env и заполните.`)
    process.exit(1)
  }
  return v
}

export const env = {
  BOT_TOKEN: required('BOT_TOKEN'),
  ADMIN_USERNAME: (process.env.ADMIN_USERNAME || '').replace(/^@/, '').toLowerCase(),
  ADMIN_CHAT_ID: process.env.ADMIN_CHAT_ID ? Number(process.env.ADMIN_CHAT_ID) : null,
  DB_PATH: resolve(root, process.env.DB_PATH || './data/bot.db'),
  MAX_ORDERS_PER_HOUR: Number(process.env.MAX_ORDERS_PER_HOUR || 5),
  // Канал, куда публикуются одобренные отзывы. Бот должен быть в нём администратором.
  REVIEWS_CHANNEL_ID: process.env.REVIEWS_CHANNEL_ID || null,
}

if (!env.ADMIN_USERNAME && !env.ADMIN_CHAT_ID) {
  console.error('Задайте ADMIN_USERNAME или ADMIN_CHAT_ID — иначе заказы некуда отправлять.')
  process.exit(1)
}

export const channels = new Map(config.channels.map(c => [c.id, c]))
export const items = new Map(config.items.map(i => [i.id, i]))

export function priceOf(item, currency) {
  const p = item.price?.[currency]
  if (typeof p !== 'number') throw new Error(`Нет цены для ${item.id} в валюте ${currency}`)
  return p
}

export function refPriceOf(item, currency) {
  const p = item.reference_price?.[currency]
  return typeof p === 'number' ? p : null
}

/** Внутри рабочих часов? Часы заданы в конфиге, интервал может переходить через полночь. */
export function isWorkingHours(now = new Date()) {
  const { from, to } = config.working_hours || {}
  if (typeof from !== 'number' || typeof to !== 'number') return true
  // Астана = UTC+5, фиксированное смещение (перехода на летнее время нет)
  const h = (now.getUTCHours() + 5) % 24
  return from <= to ? h >= from && h < to : h >= from || h < to
}
