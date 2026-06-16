require('dotenv').config();
const express = require('express');
const path    = require('path');
const { v4: uuidv4 } = require('uuid');
const { ClerkExpressRequireAuth } = require('@clerk/clerk-sdk-node');
const { Pool } = require('pg');

// ── Startup env validation ──
const REQUIRED_ENV = ['CLERK_SECRET_KEY', 'DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`\n  ✗ Missing required environment variables: ${missing.join(', ')}`);
  console.error('  → Copy .env.example to .env and fill in your values.\n');
  process.exit(1);
}

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Supabase PostgreSQL connection ──
const pool = new Pool({
  host:     process.env.DB_HOST,
  port:     parseInt(process.env.DB_PORT || '5432', 10),
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl:      { rejectUnauthorized: false },
});

// ── Create table if not exists ──
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tabs (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL,
      url           TEXT NOT NULL,
      title         TEXT,
      reason        TEXT,
      tag           TEXT DEFAULT 'ref',
      priority      TEXT DEFAULT NULL,
      saved_at      TIMESTAMPTZ NOT NULL,
      snoozed_until TIMESTAMPTZ DEFAULT NULL,
      archived      BOOLEAN DEFAULT FALSE,
      reminder      TIMESTAMPTZ DEFAULT NULL
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_user ON tabs (user_id)`);
  console.log('  ✦ Supabase database ready');
}

// ── Row → API object ──
function rowToTab(r) {
  return {
    id:           r.id,
    userId:       r.user_id,
    url:          r.url,
    title:        r.title,
    reason:       r.reason,
    tag:          r.tag,
    priority:     r.priority,
    savedAt:      r.saved_at,
    snoozedUntil: r.snoozed_until,
    archived:     !!r.archived,
    reminder:     r.reminder,
  };
}

// ── Clerk auth middleware ──
const requireAuth = ClerkExpressRequireAuth();

// ── GET /api/tabs ──
app.get('/api/tabs', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM tabs WHERE user_id = $1 ORDER BY saved_at DESC',
      [req.auth.userId]
    );
    res.json(rows.map(rowToTab));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB error' });
  }
});

// ── POST /api/tabs ──
app.post('/api/tabs', requireAuth, async (req, res) => {
  try {
    const tab = {
      id:            uuidv4(),
      user_id:       req.auth.userId,
      url:           req.body.url || '',
      title:         req.body.title || req.body.url || 'Untitled',
      reason:        req.body.reason || '',
      tag:           req.body.tag || 'ref',
      priority:      req.body.priority || null,
      saved_at:      new Date(),
      snoozed_until: null,
      archived:      false,
      reminder:      req.body.reminder ? new Date(req.body.reminder) : null,
    };
    const { rows } = await pool.query(
      `INSERT INTO tabs (id, user_id, url, title, reason, tag, priority, saved_at, snoozed_until, archived, reminder)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [tab.id, tab.user_id, tab.url, tab.title, tab.reason, tab.tag,
       tab.priority, tab.saved_at, tab.snoozed_until, tab.archived, tab.reminder]
    );
    res.json(rowToTab(rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB error' });
  }
});

// ── PATCH /api/tabs/:id ──
app.patch('/api/tabs/:id', requireAuth, async (req, res) => {
  try {
    const map = {
      url: 'url', title: 'title', reason: 'reason', tag: 'tag',
      priority: 'priority', snoozedUntil: 'snoozed_until',
      archived: 'archived', reminder: 'reminder',
    };
    const sets = [], vals = [];
    let i = 1;
    for (const [jsKey, dbCol] of Object.entries(map)) {
      if (jsKey in req.body) {
        sets.push(`${dbCol} = $${i++}`);
        vals.push(req.body[jsKey] === null ? null : req.body[jsKey]);
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    vals.push(req.params.id, req.auth.userId);
    const { rows } = await pool.query(
      `UPDATE tabs SET ${sets.join(', ')} WHERE id = $${i} AND user_id = $${i+1} RETURNING *`,
      vals
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rowToTab(rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB error' });
  }
});

// ── DELETE /api/tabs/:id ──
app.delete('/api/tabs/:id', requireAuth, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM tabs WHERE id = $1 AND user_id = $2',
      [req.params.id, req.auth.userId]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB error' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ──
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`  ✦ Tab Memory running at http://localhost:${PORT}\n`);
  });
}).catch(err => {
  console.error('\n  ✗ Supabase connection failed:', err.message);
  process.exit(1);
});

module.exports = app;
