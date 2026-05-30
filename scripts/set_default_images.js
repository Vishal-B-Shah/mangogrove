const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const { Pool } = require('pg');

const DEFAULT_IMAGE = '/uploads/default-mango.jpg';

async function runSqlite() {
  const dbPath = path.join(__dirname, '..', 'mangoes.db');
  if (!fs.existsSync(dbPath)) return console.error('SQLite DB not found:', dbPath);
  const db = new sqlite3.Database(dbPath);
  db.serialize(() => {
    db.run("UPDATE products SET image = ? WHERE image IS NULL OR image = ''", [DEFAULT_IMAGE], function(err) {
      if (err) console.error('Error running update:', err);
      else console.log(`Updated ${this.changes} rows (SQLite)`);
      db.close();
    });
  });
}

async function runPostgres() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) return console.error('DATABASE_URL not set for Postgres');
  const pool = new Pool({ connectionString: dbUrl });
  try {
    const res = await pool.query("UPDATE products SET image = $1 WHERE image IS NULL OR image = '' RETURNING id", [DEFAULT_IMAGE]);
    console.log(`Updated ${res.rowCount} rows (Postgres)`);
  } catch (e) {
    console.error('Error running Postgres update:', e.message || e);
  } finally {
    await pool.end();
  }
}

(async function() {
  if (process.env.DATABASE_URL) await runPostgres();
  else await runSqlite();
})();
