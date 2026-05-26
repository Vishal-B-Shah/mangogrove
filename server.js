const express = require('express');
const { Pool } = require('pg');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'mangogrove-secret';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'vishal.shah.ddit@gmail.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'MangoAdmin@2026';

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

function createToken(user) {
  return jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
}

function authenticate(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return next();
  try {
    req.user = jwt.verify(token, JWT_SECRET);
  } catch (err) {
    // ignore invalid token
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  next();
}

async function columnExists(table, column) {
  if (isPostgres) {
    const row = await get(
      "SELECT column_name FROM information_schema.columns WHERE table_name = ? AND column_name = ?",
      [table, column]
    );
    return Boolean(row);
  }
  const rows = await all(`PRAGMA table_info(${table})`);
  return rows.some(r => r.name === column);
}

async function ensureColumn(table, columnName, columnDef) {
  if (await columnExists(table, columnName)) return;
  await run(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
}

// ── Create tables then seed ───────────────────────────────────────────────────────────
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `upi-qr-${Date.now()}${ext}`);
    }
  }),
  fileFilter: (req, file, cb) => {
    const allowed = ['.png', '.jpg', '.jpeg', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  },
});

async function initDB() {
  await initDbConnection();

  const createUsers = isPostgres ? `CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    email         TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    role          TEXT    NOT NULL DEFAULT 'user',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )` : `CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    role          TEXT    NOT NULL DEFAULT 'user',
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  )`;

  const createPaymentSettings = isPostgres ? `CREATE TABLE IF NOT EXISTS payment_settings (
    id         SERIAL PRIMARY KEY,
    upi_id     TEXT,
    upi_qr     TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )` : `CREATE TABLE IF NOT EXISTS payment_settings (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    upi_id     TEXT,
    upi_qr     TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`;

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
    payment_status TEXT NOT NULL DEFAULT 'pending',
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
    payment_status TEXT NOT NULL DEFAULT 'pending',
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

  await run(createUsers);
  await run(createPaymentSettings);
  await run(createProducts);
  await run(createOrders);
  await run(createStockLog);

  await ensureColumn('orders', 'user_id', isPostgres ? 'user_id INTEGER' : 'user_id INTEGER');
  await ensureColumn('orders', 'payment_status', isPostgres ? "payment_status TEXT NOT NULL DEFAULT 'pending'" : "payment_status TEXT NOT NULL DEFAULT 'pending'");

  const userRow = await get('SELECT id FROM users WHERE email = ?', [ADMIN_EMAIL]);
  if (!userRow) {
    const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
    await insert('INSERT INTO users (email,password_hash,role) VALUES (?,?,?)', [ADMIN_EMAIL, passwordHash, 'admin']);
    console.log(`🔐 Seeded admin account ${ADMIN_EMAIL} (password from ADMIN_PASSWORD or default)`);
  }

  const settingsRow = await get('SELECT id FROM payment_settings LIMIT 1');
  if (!settingsRow) {
    await insert('INSERT INTO payment_settings (upi_id, upi_qr) VALUES (?,?)', ['', '']);
  }

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
app.use(authenticate);
app.use('/uploads', express.static(uploadDir));
app.use(express.static(path.join(__dirname, 'public')));

// ── PRODUCT ROUTES ────────────────────────────────────────────────────────────
app.get('/api/products', async (req, res) => {
  try { res.json(await all('SELECT * FROM products ORDER BY featured DESC, id ASC')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const user = await get('SELECT id,email,role FROM users WHERE id = ?', [req.user.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/register', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
  const normalizedEmail = String(email).trim().toLowerCase();
  try {
    const existing = await get('SELECT id FROM users WHERE email = ?', [normalizedEmail]);
    if (existing) return res.status(400).json({ error: 'Email is already registered' });
    const passwordHash = await bcrypt.hash(password, 10);
    const result = await insert('INSERT INTO users (email,password_hash,role) VALUES (?,?,?)', [normalizedEmail, passwordHash, 'user']);
    const token = createToken({ id: result.lastID, email: normalizedEmail, role: 'user' });
    res.json({ token, user: { id: result.lastID, email: normalizedEmail, role: 'user' } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
  const normalizedEmail = String(email).trim().toLowerCase();
  try {
    const user = await get('SELECT id,email,password_hash,role FROM users WHERE email = ?', [normalizedEmail]);
    if (!user) return res.status(400).json({ error: 'Invalid email or password' });
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(400).json({ error: 'Invalid email or password' });
    const token = createToken({ id: user.id, email: user.email, role: user.role });
    res.json({ token, user: { id: user.id, email: user.email, role: user.role } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/payment-settings', async (req, res) => {
  try {
    const row = await get('SELECT upi_id, upi_qr FROM payment_settings ORDER BY id DESC LIMIT 1');
    res.json(row || { upi_id: '', upi_qr: '' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/payment-settings/upload', requireAdmin, upload.single('qrImage'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const url = `/uploads/${req.file.filename}`;
    res.json({ upi_qr: url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/payment-settings', requireAdmin, async (req, res) => {
  const { upi_id, upi_qr } = req.body;
  try {
    await run('INSERT INTO payment_settings (upi_id,upi_qr) VALUES (?,?)', [upi_id || '', upi_qr || '']);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/orders/:id/payment-status', requireAdmin, async (req, res) => {
  const { payment_status } = req.body;
  const valid = ['pending', 'paid', 'cod'];
  if (!valid.includes(payment_status)) return res.status(400).json({ error: 'Invalid payment status' });
  try {
    const existing = await get('SELECT id FROM orders WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Order not found' });
    await run('UPDATE orders SET payment_status = ? WHERE id = ?', [payment_status, req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/overview', requireAdmin, async (req, res) => {
  try {
    const totalOrders = await get("SELECT COUNT(*) AS count FROM orders");
    const totalRevenue = await get("SELECT COALESCE(SUM(total),0) AS total FROM orders WHERE status != 'cancelled'");
    const totalProducts = await get("SELECT COUNT(*) AS count FROM products");
    const ordersByStatus = await all("SELECT status, COUNT(*) AS count FROM orders GROUP BY status ORDER BY status ASC");
    const revenueByPayment = await all("SELECT payment, COALESCE(SUM(total),0) AS revenue FROM orders GROUP BY payment");
    const topUsers = await all(isPostgres ? `SELECT u.email, u.role, COUNT(o.id) AS orders, COALESCE(SUM(o.total),0) AS spent
      FROM users u LEFT JOIN orders o ON u.id = o.user_id GROUP BY u.id ORDER BY spent DESC LIMIT 5` :
      `SELECT u.email, u.role, COUNT(o.id) AS orders, COALESCE(SUM(o.total),0) AS spent
      FROM users u LEFT JOIN orders o ON u.id = o.user_id GROUP BY u.id ORDER BY spent DESC LIMIT 5`
    );
    const userCount = await get("SELECT COUNT(*) AS count FROM users");
    res.json({
      totalOrders: totalOrders.count,
      totalRevenue: totalRevenue.total,
      totalProducts: totalProducts.count,
      avgOrder: totalOrders.count > 0 ? Math.round(totalRevenue.total / totalOrders.count) : 0,
      ordersByStatus,
      revenueByPayment,
      topUsers,
      userCount: userCount.count,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const users = await all('SELECT id,email,role,created_at FROM users ORDER BY id ASC');
    res.json(users);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/orders', async (req, res) => {
  try {
    const rows = await all('SELECT * FROM orders ORDER BY id DESC');
    res.json(rows.map(r => ({ ...r, items: parseItems(r.items) }))); }
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

app.post('/api/orders', requireAuth, async (req, res) => {
  const { customer_name, phone, address, city, pincode, payment, items, subtotal, delivery, total } = req.body;
  const orderItems = parseItems(items);

  if (!customer_name || !phone || !Array.isArray(orderItems) || orderItems.length === 0)
    return res.status(400).json({ error: 'customer_name, phone, and a valid items array are required' });

  const validPayments = ['upi', 'cod'];
  const paymentMethod = validPayments.includes(payment) ? payment : 'upi';
  const paymentStatus = paymentMethod === 'cod' ? 'cod' : 'pending';

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
      'INSERT INTO orders (customer_name,phone,address,city,pincode,payment,payment_status,items,subtotal,delivery,total,user_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [customer_name, phone, address, city || '', pincode || '', paymentMethod, paymentStatus, JSON.stringify(orderItems), subtotal, delivery || 0, total, req.user.id]
    );
    res.status(201).json({ id: result.lastID, status: 'preparing' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/orders/:id/status', requireAdmin, async (req, res) => {
  const { status } = req.body;
  const valid = ['preparing', 'shipped', 'delivered', 'cancelled'];
  if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  try {
    const order = await get('SELECT * FROM orders WHERE id = ?', [req.params.id]);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (['shipped', 'delivered'].includes(status) && order.payment === 'upi' && order.payment_status === 'pending') {
      return res.status(400).json({ error: 'Cannot update order to shipped or delivered before UPI payment is verified' });
    }
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
