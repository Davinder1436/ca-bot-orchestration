'use strict';

const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

// ============================================================
// Database file location
// Override with DB_PATH env var, e.g. DB_PATH=/mnt/data/shifter.db
// ============================================================
const DB_FILE = process.env.DB_PATH || path.join(__dirname, 'data', 'shifter.db');
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ============================================================
// Schema
//
//  credits       — server-authoritative credit balance
//  is_pro        — 1 = unlimited use, skip credit deduction
//  sync_interval — how many minutes between /checkCredit calls
//  last_version  — last extension version string seen
//  last_seen_at  — last time this user hit /checkCredit
// ============================================================
db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        email          TEXT    UNIQUE NOT NULL COLLATE NOCASE,
        credits        INTEGER NOT NULL DEFAULT 0,
        is_pro         INTEGER NOT NULL DEFAULT 0,
        sync_interval  INTEGER NOT NULL DEFAULT 1,
        notes          TEXT    DEFAULT NULL,
        last_version   TEXT    DEFAULT NULL,
        last_seen_at   TEXT    DEFAULT NULL,
        created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
        updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
    );
`);

// ============================================================
// Compiled prepared statements (fast reuse)
// ============================================================
const _get = db.prepare(
    'SELECT * FROM users WHERE email = ? COLLATE NOCASE'
);
const _list = db.prepare(
    'SELECT * FROM users ORDER BY created_at DESC'
);
const _insert = db.prepare(
    `INSERT INTO users (email, credits, is_pro, sync_interval, notes)
     VALUES (@email, @credits, @is_pro, @sync_interval, @notes)`
);
const _update = db.prepare(
    `UPDATE users
     SET credits = @credits, is_pro = @is_pro, sync_interval = @sync_interval,
         notes = @notes, updated_at = datetime('now')
     WHERE email = @email COLLATE NOCASE`
);
const _setCredits = db.prepare(
    `UPDATE users SET credits = @credits, updated_at = datetime('now')
     WHERE email = @email COLLATE NOCASE`
);
const _addCredits = db.prepare(
    `UPDATE users SET credits = MAX(0, credits + @amount), updated_at = datetime('now')
     WHERE email = @email COLLATE NOCASE`
);
const _touchSeen = db.prepare(
    `UPDATE users SET last_seen_at = datetime('now'), last_version = @version
     WHERE email = @email COLLATE NOCASE`
);
const _delete = db.prepare(
    'DELETE FROM users WHERE email = ? COLLATE NOCASE'
);

// ============================================================
// Public API
// ============================================================

function getUser(email) {
    return _get.get(email) || null;
}

function listUsers() {
    return _list.all();
}

function createUser({ email, credits = 0, is_pro = 0, sync_interval = 1, notes = null }) {
    _insert.run({
        email:         email.toLowerCase().trim(),
        credits:       Math.max(0, parseInt(credits, 10) || 0),
        is_pro:        is_pro ? 1 : 0,
        sync_interval: Math.max(1, parseInt(sync_interval, 10) || 1),
        notes:         notes || null,
    });
    return getUser(email);
}

/**
 * Update mutable fields on an existing user.
 * Only fields present in `fields` are changed; omitted fields keep their value.
 */
function updateUser(email, fields) {
    const existing = getUser(email);
    if (!existing) return null;

    const merged = {
        email,
        credits:      fields.credits       != null ? Math.max(0, parseInt(fields.credits, 10))  : existing.credits,
        is_pro:       fields.is_pro        != null ? (fields.is_pro ? 1 : 0)                     : existing.is_pro,
        sync_interval: fields.sync_interval != null ? Math.max(1, parseInt(fields.sync_interval, 10)) : existing.sync_interval,
        notes:        fields.notes !== undefined    ? fields.notes                               : existing.notes,
    };
    _update.run(merged);
    return getUser(email);
}

/** Overwrite credit balance exactly. */
function setCredits(email, credits) {
    _setCredits.run({ email, credits: Math.max(0, parseInt(credits, 10) || 0) });
}

/** Add (or subtract if negative) credits. Floor is 0. */
function addCredits(email, amount) {
    _addCredits.run({ email, amount: parseInt(amount, 10) || 0 });
}

/** Update last_seen_at + last_version without touching credits. */
function touchSeen(email, version) {
    _touchSeen.run({ email, version: version || null });
}

/** Returns true if the row was deleted. */
function deleteUser(email) {
    return _delete.run(email).changes > 0;
}

module.exports = {
    db,
    getUser,
    listUsers,
    createUser,
    updateUser,
    setCredits,
    addCredits,
    touchSeen,
    deleteUser,
};
