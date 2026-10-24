'use strict'

const path = require('node:path')

const { readJson, writeJsonAtomic } = require('../../src/config-store')

const STATE_FILE = 'data/plugins/fortune/data/fortune.json'

function statePath(rootDir, file = STATE_FILE) {
  return path.resolve(rootDir, file)
}

function readState(rootDir, file = STATE_FILE) {
  const raw = readJson(statePath(rootDir, file), { groups: {}, users: {} })
  return {
    groups: raw.groups && typeof raw.groups === 'object' ? raw.groups : {},
    users: raw.users && typeof raw.users === 'object' ? raw.users : {},
  }
}

function writeState(rootDir, state, file = STATE_FILE) {
  writeJsonAtomic(statePath(rootDir, file), state)
}

/** Local calendar date (YYYY-MM-DD) used for the one-draw-per-day rule. */
function todayStamp(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** Group id, or a per-user private scope. */
function scopeKey(session) {
  return session.isGroup ? String(session.groupId) : `private:${session.userId}`
}

/** User key inside a scope (private scopes only ever have one user). */
function userKey(session) {
  return session.isGroup ? String(session.userId) : 'self'
}

module.exports = { STATE_FILE, statePath, readState, writeState, todayStamp, scopeKey, userKey }


