const express = require('express');
const { Pool } = require('pg');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5000;

// ── Database connection and helpers ───────────────────────────────────────────
const isPostgres = Boolean(process.env.DATABASE_URL);

let db = null;
let pool = null;

function formatSql(sql) {
  if (!isPostgres) return sql;
  let index = 1;
  return sql.replace(/\?/g, () => `$${index++}`);
}

async function openSqlite() {
  return new Promise((resolve, reject) => {
    db = new sqlite3.Database(path.join(__dirname, 'mangoes.db'), (err) => {
      if (err) return reject(err);
      console.log('📦 SQLite fallback database ready (mangoes.db)');
      resolve();
    });
  });
}

async function openPostgres() {
  const dbUrl = process.env.DATABASE_URL || '';
  if (!dbUrl) throw new Error('DATABASE_URL is not set');

  const parsed = new URL(dbUrl);
  const host = parsed.hostname;
  const sslMode = parsed.searchParams.get('sslmode');
  const isLocal = ['localhost', '127.0.0.1', '::1'].includes(host);
  const useSsl = sslMode
    ? !['disable', 'allow', 'prefer'].includes(sslMode.toLowerCase())
    : !isLocal;

  console.log(`🔌 Connecting to Postgres host=${host} sslMode=${sslMode || 'default'} useSsl=${useSsl}`);

  pool = new Pool({
    connectionString: dbUrl,
    ssl: useSsl ? { rejectUnauthorized: false } : false
  });

  await pool.query('SELECT 1');
  console.log('📦 PostgreSQL database connected');
}

async function initDbConnection() {
  if (isPostgres) {
    await openPostgres();
  } else {
    await openSqlite();
  }
}

async function run(sql, params = []) {
  sql = formatSql(sql);
  if (isPostgres) {
    const result = await pool.query(sql, params);
    return { changes: result.rowCount };
  }
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

async function insert(sql, params = []) {
  if (isPostgres) {
    const postgresSql = `${formatSql(sql)} RETURNING id`;
    const result = await pool.query(postgresSql, params);
    return { lastID: result.rows[0]?.id };
  }
  return run(sql, params);
}

async function all(sql, params = []) {
  sql = formatSql(sql);
  if (isPostgres) {
    const result = await pool.query(sql, params);
    return result.rows;
  }
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

async function get(sql, params = []) {
  sql = formatSql(sql);
  if (isPostgres) {
    const result = await pool.query(sql, params);
    return result.rows[0] || null;
  }
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function parseItems(items) {
  if (!items) return [];
  if (typeof items === 'string') {
    try { return JSON.parse(items); } catch (err) { return []; }
  }
  return items;
}

// ── Create tables then seed ───────────────────────────────────────────────────
async function initDB() {
  await initDbConnection();

  const createProducts = isPostgres ? `CREATE TABLE IF NOT EXISTS products (
    id          SERIAL PRIMARY KEY,
    name        TEXT    NOT NULL,
    emoji       TEXT    NOT NULL DEFAULT '🥭',
    price       INTEGER NOT NULL,
    stock       INTEGER NOT NULL DEFAULT 0,
    origin      TEXT,
    description TEXT,
    type        TEXT    NOT NULL DEFAULT 'seasonal',
    featured    BOOLEAN NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )` : `CREATE TABLE IF NOT EXISTS products (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    emoji       TEXT    NOT NULL DEFAULT '🥭',
    price       INTEGER NOT NULL,
    stock       INTEGER NOT NULL DEFAULT 0,
    origin      TEXT,
    description TEXT,
    type        TEXT    NOT NULL DEFAULT 'seasonal',
    featured    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  )`;

  const createOrders = isPostgres ? `CREATE TABLE IF NOT EXISTS orders (
    id            SERIAL PRIMARY KEY,
    customer_name TEXT NOT NULL,
    phone         TEXT NOT NULL,
    address       TEXT NOT NULL,
    city          TEXT NOT NULL DEFAULT '',
    pincode       TEXT NOT NULL DEFAULT '',
    payment       TEXT NOT NULL DEFAULT 'upi',
    items         JSONB NOT NULL,
    subtotal      INTEGER NOT NULL,
    delivery      INTEGER NOT NULL DEFAULT 0,
    total         INTEGER NOT NULL,
    status        TEXT NOT NULL DEFAULT 'preparing',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )` : `CREATE TABLE IF NOT EXISTS orders (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_name TEXT NOT NULL,
    phone         TEXT NOT NULL,
    address       TEXT NOT NULL,
    city          TEXT NOT NULL DEFAULT '',
    pincode       TEXT NOT NULL DEFAULT '',
    payment       TEXT NOT NULL DEFAULT 'upi',
    items         TEXT NOT NULL,
    subtotal      INTEGER NOT NULL,
    delivery      INTEGER NOT NULL DEFAULT 0,
    total         INTEGER NOT NULL,
    status        TEXT NOT NULL DEFAULT 'preparing',
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  )`;

  const createStockLog = isPostgres ? `CREATE TABLE IF NOT EXISTS stock_log (
    id         SERIAL PRIMARY KEY,
    product_id INTEGER NOT NULL,
    change     INTEGER NOT NULL,
    reason     TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )` : `CREATE TABLE IF NOT EXISTS stock_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    change     INTEGER NOT NULL,
    reason     TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`;

  await run(createProducts);
  await run(createOrders);
  await run(createStockLog);

  const row = await get('SELECT COUNT(*) AS c FROM products');
  const count = parseInt(row?.c, 10) || 0;
  if (count === 0) {
    console.log('🌱 Seeding initial mango varieties...');
    const seeds = [
      ['Alphonso (Hapus)', '🥭', 599, 80,  'Ratnagiri, Maharashtra', 'The king of mangoes. Buttery, fibre-free, intensely sweet with a floral aroma.', 'premium',  true],
      ['Kesar',            '🟡', 349, 120, 'Gir, Gujarat',           'Saffron-hued flesh, honey-sweet with a distinctive fragrance. Best for aamras.',  'seasonal', true],
      ['Chaunsa',          '🥭', 429, 45,  'Punjab',                 'Silky, nectar-sweet with an intoxicating scent. Highly prized variety.',            'premium',  true],
      ['Dasheri',          '🟠', 279, 60,  'Lucknow, UP',            'Long, slim mangoes with smooth, sweet pulp. Perfect for summer drinks.',            'seasonal', false],
      ['Langra',           '🍋', 259, 90,  'Varanasi, UP',           'Green even when ripe, with a tangy-sweet, slightly tart flavour profile.',          'bulk',     false],
      ['Totapuri',         '🫑', 199, 200, 'Andhra Pradesh',         'Large, elongated with mild tartness. Great for pickles and juices.',                'bulk',     false],
    ];
    for (const s of seeds) {
      await run(
        'INSERT INTO products (name,emoji,price,stock,origin,description,type,featured) VALUES (?,?,?,?,?,?,?,?)',
        s
      );
    }
    console.log('✅ Seeded 6 mango varieties.');
  }
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── PRODUCT ROUTES ────────────────────────────────────────────────────────────
app.get('/api/products', async (req, res) => {
  try { res.json(await all('SELECT * FROM products ORDER BY featured DESC, id ASC')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/products/:id', async (req, res) => {
  try {
    const row = await get('SELECT * FROM products WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Product not found' });
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/products', async (req, res) => {
  const { name, emoji, price, stock, origin, description, type, featured } = req.body;
  if (!name || !price) return res.status(400).json({ error: 'name and price are required' });
  try {
    const result = await insert(
      'INSERT INTO products (name,emoji,price,stock,origin,description,type,featured) VALUES (?,?,?,?,?,?,?,?)',
      [name, emoji || '🥭', price, stock || 0, origin || '', description || '', type || 'seasonal', featured ? true : false]
    );
    res.status(201).json({ id: result.lastID, ...req.body });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/products/:id', async (req, res) => {
  const { name, emoji, price, stock, origin, description, type, featured } = req.body;
  try {
    const existing = await get('SELECT id FROM products WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Product not found' });
    await run(
      'UPDATE products SET name=?,emoji=?,price=?,stock=?,origin=?,description=?,type=?,featured=? WHERE id=?',
      [name, emoji, price, stock, origin, description, type, featured ? 1 : 0, req.params.id]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/products/:id', async (req, res) => {
  try {
    const existing = await get('SELECT id FROM products WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Product not found' });
    await run('DELETE FROM products WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/products/:id/stock', async (req, res) => {
  const { change, reason } = req.body;
  try {
    const product = await get('SELECT * FROM products WHERE id = ?', [req.params.id]);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    const newStock = product.stock + parseInt(change);
    if (newStock < 0) return res.status(400).json({ error: 'Insufficient stock' });
    await run('UPDATE products SET stock = ? WHERE id = ?', [newStock, req.params.id]);
    await run('INSERT INTO stock_log (product_id, change, reason) VALUES (?,?,?)', [req.params.id, change, reason || 'manual']);
    res.json({ id: req.params.id, newStock });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ORDER ROUTES ──────────────────────────────────────────────────────────────
app.get('/api/orders', async (req, res) => {
  try {
    const rows = await all('SELECT * FROM orders ORDER BY id DESC');
    res.json(rows.map(r => ({ ...r, items: parseItems(r.items) })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/orders', async (req, res) => {
  const { customer_name, phone, address, city, pincode, payment, items, subtotal, delivery, total } = req.body;
  const orderItems = parseItems(items);

  if (!customer_name || !phone || !Array.isArray(orderItems) || orderItems.length === 0)
    return res.status(400).json({ error: 'customer_name, phone, and a valid items array are required' });

  try {
    // Check and deduct stock for each item
    for (const item of orderItems) {
      if (!item?.id || typeof item.qty !== 'number') {
        return res.status(400).json({ error: 'Each order item must include id and qty' });
      }
      const product = await get('SELECT * FROM products WHERE id = ?', [item.id]);
      if (!product) return res.status(400).json({ error: `Product "${item.name || item.id}" not found` });
      if (product.stock < item.qty) return res.status(400).json({ error: `Not enough stock for ${item.name || item.id} (only ${product.stock}kg left)` });
      await run('UPDATE products SET stock = stock - ? WHERE id = ?', [item.qty, item.id]);
      await run('INSERT INTO stock_log (product_id, change, reason) VALUES (?,?,?)', [item.id, -item.qty, 'order']);
    }
    const result = await insert(
      'INSERT INTO orders (customer_name,phone,address,city,pincode,payment,items,subtotal,delivery,total) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [customer_name, phone, address, city || '', pincode || '', payment || 'upi', JSON.stringify(orderItems), subtotal, delivery || 0, total]
    );
    res.status(201).json({ id: result.lastID, status: 'preparing' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/orders/:id/status', async (req, res) => {
  const { status } = req.body;
  const valid = ['preparing', 'shipped', 'delivered', 'cancelled'];
  if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  try {
    const existing = await get('SELECT id FROM orders WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Order not found' });
    await run('UPDATE orders SET status = ? WHERE id = ?', [status, req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── STATS ─────────────────────────────────────────────────────────────────────
app.get('/api/stats', async (req, res) => {
  try {
    const { totalOrders }  = await get("SELECT COUNT(*) AS totalOrders FROM orders");
    const { totalRevenue } = await get("SELECT COALESCE(SUM(total),0) AS totalRevenue FROM orders WHERE status != 'cancelled'");
    const { totalProducts }= await get("SELECT COUNT(*) AS totalProducts FROM products");
    const avgOrder = totalOrders > 0 ? Math.round(totalRevenue / totalOrders) : 0;
    const lowStock = await all("SELECT * FROM products WHERE stock < 20 ORDER BY stock ASC");
    res.json({ totalOrders, totalRevenue, totalProducts, avgOrder, lowStock });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Catch-all ─────────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🥭 MangoGrove is running!`);
    console.log(`   Store  → http://localhost:${PORT}`);
    console.log(`   Admin  → http://localhost:${PORT}  (click Admin in nav)\n`);
  });
}).catch(err => {
  console.error('Failed to initialise database:', err);
  process.exit(1);
});
