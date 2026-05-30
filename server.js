const express = require('express');
const { Pool } = require('pg');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'mangogrove-secret';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'vishal.shah.ddit@gmail.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'MangoAdmin@2026';

const PAYMENT_METHODS_PATH = path.join(__dirname, 'data', 'payment_methods.json');

async function readPaymentMethods() {
  try {
    const data = await fs.promises.readFile(PAYMENT_METHODS_PATH, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    // default methods if file missing or invalid
    return { upi: true, cod: true };
  }
}

async function writePaymentMethods(obj) {
  try {
    const dir = path.dirname(PAYMENT_METHODS_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    await fs.promises.writeFile(PAYMENT_METHODS_PATH, JSON.stringify(obj, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Failed to write payment methods:', err);
    return false;
  }
}

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

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

let emailTransport;
async function getEmailTransport() {
  if (emailTransport) return emailTransport;
  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT, 10) : undefined;
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  const smtpSecure = process.env.SMTP_SECURE === 'true';
  if (smtpHost && smtpPort) {
    emailTransport = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpSecure,
      auth: smtpUser ? { user: smtpUser, pass: smtpPass } : undefined,
    });
  } else {
    // If Gmail credentials are provided, prefer creating a Gmail SMTP transport
    const gmailUser = process.env.GMAIL_USER;
    const gmailPass = process.env.GMAIL_PASS;
    if (gmailUser && gmailPass) {
      emailTransport = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        auth: { user: gmailUser, pass: gmailPass },
      });
      console.log('📧 Using Gmail SMTP transport (GMAIL_USER provided).');
    } else {
      const testAccount = await nodemailer.createTestAccount();
      emailTransport = nodemailer.createTransport({
        host: testAccount.smtp.host,
        port: testAccount.smtp.port,
        secure: testAccount.smtp.secure,
        auth: { user: testAccount.user, pass: testAccount.pass },
      });
      console.log('📧 Using Ethereal test account for email delivery. Preview URLs will be logged.');
    }
  }
  return emailTransport;
}

async function sendEmail(to, subject, text, html) {
  try {
    const transport = await getEmailTransport();
    const from = process.env.SMTP_FROM || 'MangoGrove <no-reply@mangogrove.local>';
    const info = await transport.sendMail({ from, to, subject, text, html });
    console.log(`📧 Sent email to ${to}: ${info.messageId}`);
    if (nodemailer.getTestMessageUrl) {
      const url = nodemailer.getTestMessageUrl(info);
      if (url) console.log(`📨 Preview URL: ${url}`);
    }
    return info;
  } catch (error) {
    console.error('Failed to send email with primary transport:', error && error.message ? error.message : error);

    // If primary transport failed, and Gmail credentials are available, try Gmail as a fallback
    const gmailUser = process.env.GMAIL_USER;
    const gmailPass = process.env.GMAIL_PASS;
    try {
      const current = emailTransport;
      const isAlreadyGmail = current && ((current.options && current.options.host === 'smtp.gmail.com') || (current && current.transporter && current.transporter.name && current.transporter.name.includes('Gmail')));
      if (!isAlreadyGmail && gmailUser && gmailPass) {
        console.log('📧 Attempting fallback via Gmail SMTP...');
        const gmailTransport = nodemailer.createTransport({
          host: 'smtp.gmail.com',
          port: 465,
          secure: true,
          auth: { user: gmailUser, pass: gmailPass },
        });
        const from = process.env.SMTP_FROM || `MangoGrove <${gmailUser}>`;
        const info = await gmailTransport.sendMail({ from, to, subject, text, html });
        console.log(`📧 Sent email via Gmail to ${to}: ${info.messageId}`);
        return info;
      }
    } catch (gmailErr) {
      console.error('Gmail fallback also failed:', gmailErr && gmailErr.message ? gmailErr.message : gmailErr);
    }

    // Final log if all attempts failed
    console.error('All email delivery attempts failed.');
    throw new Error('Email delivery failed - check SMTP/GMAIL settings and server logs');
  }
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

// Multer for product images (stored under uploads/products)
const productUploadDir = path.join(uploadDir, 'products');
if (!fs.existsSync(productUploadDir)) fs.mkdirSync(productUploadDir, { recursive: true });
const productUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, productUploadDir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      const safeBase = `product-${req.params && req.params.id ? req.params.id : 'anon'}-${Date.now()}`.replace(/[^a-zA-Z0-9-_\.]/g, '-');
      cb(null, `${safeBase}${ext}`);
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.png', '.jpg', '.jpeg', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  }
});

// Multer for user-uploaded payment proofs (images or PDF), 5MB limit
const uploadProof = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `payment-proof-${Date.now()}${ext}`);
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.png', '.jpg', '.jpeg', '.webp', '.pdf'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  },
});

async function initDB() {
  await initDbConnection();

  const createUsers = isPostgres ? `CREATE TABLE IF NOT EXISTS users (
    id                      SERIAL PRIMARY KEY,
    email                   TEXT    NOT NULL UNIQUE,
    password_hash           TEXT    NOT NULL,
    first_name              TEXT    NOT NULL DEFAULT '',
    last_name               TEXT    NOT NULL DEFAULT '',
    age                     INTEGER,
    gender                  TEXT,
    email_verified          BOOLEAN NOT NULL DEFAULT false,
    email_verification_token TEXT,
    email_verification_expires_at TIMESTAMPTZ,
    password_reset_token    TEXT,
    password_reset_expires_at TIMESTAMPTZ,
    role                    TEXT    NOT NULL DEFAULT 'user',
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )` : `CREATE TABLE IF NOT EXISTS users (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    email                   TEXT    NOT NULL UNIQUE,
    password_hash           TEXT    NOT NULL,
    first_name              TEXT    NOT NULL DEFAULT '',
    last_name               TEXT    NOT NULL DEFAULT '',
    age                     INTEGER,
    gender                  TEXT,
    email_verified          INTEGER NOT NULL DEFAULT 0,
    email_verification_token TEXT,
    email_verification_expires_at TEXT,
    password_reset_token    TEXT,
    password_reset_expires_at TEXT,
    role                    TEXT    NOT NULL DEFAULT 'user',
    created_at              TEXT    NOT NULL DEFAULT (datetime('now'))
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
    image       TEXT,
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
    image       TEXT,
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
    user_id       INTEGER,
    address_id    INTEGER,
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
    user_id       INTEGER,
    address_id    INTEGER,
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

  const createAddresses = isPostgres ? `CREATE TABLE IF NOT EXISTS addresses (
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER NOT NULL,
    label       TEXT,
    full_name   TEXT NOT NULL,
    phone       TEXT NOT NULL,
    line1       TEXT NOT NULL,
    line2       TEXT,
    city        TEXT NOT NULL,
    state       TEXT,
    pincode     TEXT NOT NULL,
    is_default  BOOLEAN NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )` : `CREATE TABLE IF NOT EXISTS addresses (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL,
    label       TEXT,
    full_name   TEXT NOT NULL,
    phone       TEXT NOT NULL,
    line1       TEXT NOT NULL,
    line2       TEXT,
    city        TEXT NOT NULL,
    state       TEXT,
    pincode     TEXT NOT NULL,
    is_default  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
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

  const createUserFavorites = isPostgres ? `CREATE TABLE IF NOT EXISTS user_favorites (
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER NOT NULL,
    product_id  INTEGER NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )` : `CREATE TABLE IF NOT EXISTS user_favorites (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL,
    product_id  INTEGER NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  )`;

  await run(createUsers);
  await run(createPaymentSettings);
  await run(createProducts);
  await run(createOrders);
  await run(createAddresses);
  await run(createStockLog);
  await run(createUserFavorites);

  await ensureColumn('users', 'first_name', isPostgres ? "first_name TEXT NOT NULL DEFAULT ''" : "first_name TEXT NOT NULL DEFAULT ''");
  await ensureColumn('users', 'last_name', isPostgres ? "last_name TEXT NOT NULL DEFAULT ''" : "last_name TEXT NOT NULL DEFAULT ''");
  await ensureColumn('users', 'age', isPostgres ? 'age INTEGER' : 'age INTEGER');
  await ensureColumn('users', 'gender', isPostgres ? 'gender TEXT' : 'gender TEXT');
  await ensureColumn('users', 'email_verified', isPostgres ? "email_verified BOOLEAN NOT NULL DEFAULT false" : "email_verified INTEGER NOT NULL DEFAULT 0");
  await ensureColumn('users', 'email_verification_token', isPostgres ? 'email_verification_token TEXT' : 'email_verification_token TEXT');
  await ensureColumn('users', 'email_verification_expires_at', isPostgres ? 'email_verification_expires_at TIMESTAMPTZ' : 'email_verification_expires_at TEXT');
  await ensureColumn('users', 'password_reset_token', isPostgres ? 'password_reset_token TEXT' : 'password_reset_token TEXT');
  await ensureColumn('users', 'password_reset_expires_at', isPostgres ? 'password_reset_expires_at TIMESTAMPTZ' : 'password_reset_expires_at TEXT');
  await ensureColumn('users', 'disabled', isPostgres ? "disabled BOOLEAN NOT NULL DEFAULT false" : "disabled INTEGER NOT NULL DEFAULT 0");
  await ensureColumn('users', 'disabled_reason', isPostgres ? 'disabled_reason TEXT' : 'disabled_reason TEXT');
  await ensureColumn('users', 'disabled_at', isPostgres ? 'disabled_at TIMESTAMPTZ' : 'disabled_at TEXT');
  await ensureColumn('orders', 'user_id', isPostgres ? 'user_id INTEGER' : 'user_id INTEGER');
  await ensureColumn('orders', 'address_id', isPostgres ? 'address_id INTEGER' : 'address_id INTEGER');
  await ensureColumn('orders', 'payment_status', isPostgres ? "payment_status TEXT NOT NULL DEFAULT 'pending'" : "payment_status TEXT NOT NULL DEFAULT 'pending'");
  // Columns to support manual UPI payment verification
  await ensureColumn('orders', 'payment_proof', isPostgres ? 'payment_proof TEXT' : 'payment_proof TEXT');
  await ensureColumn('orders', 'payment_remark', isPostgres ? 'payment_remark TEXT' : 'payment_remark TEXT');
  await ensureColumn('orders', 'payment_verified_at', isPostgres ? 'payment_verified_at TIMESTAMPTZ' : 'payment_verified_at TEXT');

  // Ensure products.image column exists
  await ensureColumn('products', 'image', isPostgres ? 'image TEXT' : 'image TEXT');

  const userRow = await get('SELECT id FROM users WHERE email = ?', [ADMIN_EMAIL]);
  if (!userRow) {
    const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
    await insert('INSERT INTO users (email,password_hash,role,email_verified) VALUES (?,?,?,?)', [ADMIN_EMAIL, passwordHash, 'admin', isPostgres ? true : 1]);
    console.log(`🔐 Seeded admin account ${ADMIN_EMAIL} (password from ADMIN_PASSWORD or default)`);
  } else {
    await run('UPDATE users SET email_verified = ? WHERE id = ?', [isPostgres ? true : 1, userRow.id]);
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
    const user = await get('SELECT id,email,role,first_name,last_name,age,gender,email_verified FROM users WHERE id = ?', [req.user.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const { first_name, last_name, age, gender } = req.body || {};
    await run('UPDATE users SET first_name = ?, last_name = ?, age = ?, gender = ? WHERE id = ?', [
      first_name || '', last_name || '', age ? parseInt(age, 10) : null, gender || '', req.user.id
    ]);
    const user = await get('SELECT id,email,role,first_name,last_name,age,gender,email_verified FROM users WHERE id = ?', [req.user.id]);
    res.json(user);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/register', async (req, res) => {
  const { email, password, first_name, last_name, age, gender } = req.body;
  if (!email || !password || !first_name || !last_name) return res.status(400).json({ error: 'Email, password, first name and last name are required' });
  const normalizedEmail = String(email).trim().toLowerCase();
  try {
    const existing = await get('SELECT id FROM users WHERE email = ?', [normalizedEmail]);
    if (existing) return res.status(400).json({ error: 'Email is already registered' });
    const passwordHash = await bcrypt.hash(password, 10);
    const otp = generateOtp();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const result = await insert(
      'INSERT INTO users (email,password_hash,first_name,last_name,age,gender,email_verified,email_verification_token,email_verification_expires_at,role) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [normalizedEmail, passwordHash, first_name.trim(), last_name.trim(), age ? parseInt(age, 10) : null, gender || '', false, otp, expiresAt, 'user']
    );
    await sendEmail(normalizedEmail, 'MangoGrove Email Verification',
      `Your MangoGrove verification code is ${otp}. It expires in 15 minutes.`,
      `<p>Your MangoGrove verification code is <strong>${otp}</strong>.</p><p>It expires in 15 minutes.</p>`
    );
    res.json({ success: true, message: 'Account created. Check your email for the verification code.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/resend-verification', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });
  const normalizedEmail = String(email).trim().toLowerCase();
  try {
    const user = await get('SELECT id,email,email_verified FROM users WHERE email = ?', [normalizedEmail]);
    if (!user) return res.status(400).json({ error: 'Email is not registered' });
    if (user.email_verified) return res.status(400).json({ error: 'Email is already verified' });
    const otp = generateOtp();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    await run('UPDATE users SET email_verification_token = ?, email_verification_expires_at = ? WHERE id = ?', [otp, expiresAt, user.id]);
    await sendEmail(normalizedEmail, 'MangoGrove Verification Code',
      `Your MangoGrove verification code is ${otp}. It expires in 15 minutes.`,
      `<p>Your MangoGrove verification code is <strong>${otp}</strong>.</p><p>It expires in 15 minutes.</p>`
    );
    res.json({ success: true, message: 'Verification code resent to your email.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/verify-email', async (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) return res.status(400).json({ error: 'Email and verification code are required' });
  const normalizedEmail = String(email).trim().toLowerCase();
  try {
    const user = await get('SELECT id,email,password_hash,role,email_verified,email_verification_token,email_verification_expires_at,first_name,last_name,age,gender FROM users WHERE email = ?', [normalizedEmail]);
    if (!user) return res.status(400).json({ error: 'Invalid email or verification code' });
    if (user.email_verified) return res.status(400).json({ error: 'Email is already verified' });
    if (!user.email_verification_token || user.email_verification_token !== otp) return res.status(400).json({ error: 'Invalid verification code' });
    if (new Date() > new Date(user.email_verification_expires_at)) return res.status(400).json({ error: 'Verification code has expired' });
    await run('UPDATE users SET email_verified = ?, email_verification_token = NULL, email_verification_expires_at = NULL WHERE id = ?', [isPostgres ? true : 1, user.id]);
    const token = createToken({ id: user.id, email: user.email, role: user.role });
    res.json({ token, user: { id: user.id, email: user.email, role: user.role, first_name: user.first_name, last_name: user.last_name, age: user.age, gender: user.gender } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
  const normalizedEmail = String(email).trim().toLowerCase();
  try {
    const user = await get('SELECT id,email,password_hash,role,email_verified,first_name,last_name,age,gender,disabled,disabled_reason FROM users WHERE email = ?', [normalizedEmail]);
    if (!user) return res.status(400).json({ error: 'Invalid email or password' });
    if (!user.email_verified) return res.status(400).json({ error: 'Email is not verified. Please verify your email before logging in.' });
    if (user.disabled) return res.status(403).json({ error: 'USER_DISABLED', message: user.disabled_reason || 'This account has been disabled' });
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(400).json({ error: 'Invalid email or password' });
    const token = createToken({ id: user.id, email: user.email, role: user.role });
    res.json({ token, user: { id: user.id, email: user.email, role: user.role, first_name: user.first_name, last_name: user.last_name, age: user.age, gender: user.gender } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });
  const normalizedEmail = String(email).trim().toLowerCase();
  try {
    const user = await get('SELECT id,email FROM users WHERE email = ?', [normalizedEmail]);
    if (!user) return res.status(400).json({ error: 'Email is not registered' });
    const otp = generateOtp();
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    await run('UPDATE users SET password_reset_token = ?, password_reset_expires_at = ? WHERE id = ?', [otp, expiresAt, user.id]);
    await sendEmail(normalizedEmail, 'MangoGrove Password Reset',
      `Your MangoGrove password reset code is ${otp}. It expires in 30 minutes.`,
      `<p>Your MangoGrove password reset code is <strong>${otp}</strong>.</p><p>It expires in 30 minutes.</p>`
    );
    res.json({ success: true, message: 'Password reset code sent to your email.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/reset-password', async (req, res) => {
  const { email, otp, password } = req.body;
  if (!email || !otp || !password) return res.status(400).json({ error: 'Email, code and new password are required' });
  const normalizedEmail = String(email).trim().toLowerCase();
  try {
    const user = await get('SELECT id,password_reset_token,password_reset_expires_at FROM users WHERE email = ?', [normalizedEmail]);
    if (!user) return res.status(400).json({ error: 'Invalid email or reset code' });
    if (!user.password_reset_token || user.password_reset_token !== otp) return res.status(400).json({ error: 'Invalid reset code' });
    if (new Date() > new Date(user.password_reset_expires_at)) return res.status(400).json({ error: 'Reset code has expired' });
    const passwordHash = await bcrypt.hash(password, 10);
    await run('UPDATE users SET password_hash = ?, password_reset_token = NULL, password_reset_expires_at = NULL WHERE id = ?', [passwordHash, user.id]);
    res.json({ success: true, message: 'Password has been reset successfully' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/users/addresses', requireAuth, async (req, res) => {
  try {
    const addresses = await all('SELECT * FROM addresses WHERE user_id = ? ORDER BY is_default DESC, id DESC', [req.user.id]);
    res.json(addresses.map(a => ({
      ...a,
      is_default: Boolean(a.is_default)
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/users/addresses', requireAuth, async (req, res) => {
  const { label, full_name, phone, line1, line2, city, state, pincode, is_default } = req.body;
  if (!full_name || !phone || !line1 || !city || !pincode) return res.status(400).json({ error: 'Full name, phone, line1, city and pincode are required' });
  try {
    if (is_default) {
      await run('UPDATE addresses SET is_default = ? WHERE user_id = ?', [isPostgres ? false : 0, req.user.id]);
    }
    const result = await insert(
      'INSERT INTO addresses (user_id,label,full_name,phone,line1,line2,city,state,pincode,is_default) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [req.user.id, label || '', full_name.trim(), phone.trim(), line1.trim(), line2?.trim() || '', city.trim(), state?.trim() || '', pincode.trim(), is_default ? (isPostgres ? true : 1) : (isPostgres ? false : 0)]
    );
    res.status(201).json({ id: result.lastID });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/users/addresses/:id', requireAuth, async (req, res) => {
  const { label, full_name, phone, line1, line2, city, state, pincode, is_default } = req.body;
  const addressId = req.params.id;
  if (!full_name || !phone || !line1 || !city || !pincode) return res.status(400).json({ error: 'Full name, phone, line1, city and pincode are required' });
  try {
    const address = await get('SELECT * FROM addresses WHERE id = ? AND user_id = ?', [addressId, req.user.id]);
    if (!address) return res.status(404).json({ error: 'Address not found' });
    if (is_default) {
      await run('UPDATE addresses SET is_default = ? WHERE user_id = ?', [isPostgres ? false : 0, req.user.id]);
    }
    await run(
      'UPDATE addresses SET label = ?, full_name = ?, phone = ?, line1 = ?, line2 = ?, city = ?, state = ?, pincode = ?, is_default = ? WHERE id = ? AND user_id = ?',
      [label || '', full_name.trim(), phone.trim(), line1.trim(), line2?.trim() || '', city.trim(), state?.trim() || '', pincode.trim(), is_default ? (isPostgres ? true : 1) : (isPostgres ? false : 0), addressId, req.user.id]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/users/addresses/:id', requireAuth, async (req, res) => {
  const addressId = req.params.id;
  try {
    const address = await get('SELECT * FROM addresses WHERE id = ? AND user_id = ?', [addressId, req.user.id]);
    if (!address) return res.status(404).json({ error: 'Address not found' });
    await run('DELETE FROM addresses WHERE id = ? AND user_id = ?', [addressId, req.user.id]);
    if (address.is_default) {
      const nextAddress = await get('SELECT id FROM addresses WHERE user_id = ? ORDER BY id DESC LIMIT 1', [req.user.id]);
      if (nextAddress) {
        await run('UPDATE addresses SET is_default = ? WHERE id = ?', [isPostgres ? true : 1, nextAddress.id]);
      }
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── USER FAVORITES ─────────────────────────────────────────────────────────
app.get('/api/users/me/favorites', requireAuth, async (req, res) => {
  try {
    const rows = await all('SELECT p.* FROM products p JOIN user_favorites uf ON uf.product_id = p.id WHERE uf.user_id = ? ORDER BY p.featured DESC, p.id ASC', [req.user.id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/users/me/favorites', requireAuth, async (req, res) => {
  try {
    const productId = parseInt(req.body && req.body.product_id, 10);
    if (!productId) return res.status(400).json({ error: 'product_id is required' });
    const product = await get('SELECT id FROM products WHERE id = ?', [productId]);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    // avoid duplicates
    const exists = await get('SELECT id FROM user_favorites WHERE user_id = ? AND product_id = ?', [req.user.id, productId]);
    if (exists) return res.status(200).json({ success: true });
    await insert('INSERT INTO user_favorites (user_id,product_id) VALUES (?,?)', [req.user.id, productId]);
    res.status(201).json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/users/me/favorites/:product_id', requireAuth, async (req, res) => {
  try {
    const productId = parseInt(req.params.product_id, 10);
    if (!productId) return res.status(400).json({ error: 'Invalid product id' });
    await run('DELETE FROM user_favorites WHERE user_id = ? AND product_id = ?', [req.user.id, productId]);
    res.json({ success: true });
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

// Public: list available payment methods and which are enabled
app.get('/api/payment-methods', async (req, res) => {
  try {
    const methods = await readPaymentMethods();
    res.json({ methods });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: view payment methods
app.get('/api/admin/payment-methods', requireAdmin, async (req, res) => {
  try {
    const methods = await readPaymentMethods();
    res.json(methods);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: toggle a payment method on/off. Accepts optional { enabled: boolean } body, otherwise toggles
app.post('/api/admin/payment-methods/:method/toggle', requireAdmin, async (req, res) => {
  try {
    const method = String(req.params.method || '').trim();
    const bodyEnabled = req.body && typeof req.body.enabled === 'boolean' ? req.body.enabled : null;
    const methods = await readPaymentMethods();
    if (!Object.prototype.hasOwnProperty.call(methods, method)) return res.status(404).json({ error: 'Payment method not found' });
    methods[method] = bodyEnabled === null ? !methods[method] : bodyEnabled;
    await writePaymentMethods(methods);
    res.json(methods);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/orders/:id/payment-status', requireAdmin, async (req, res) => {
  const { payment_status, remark } = req.body;
  const valid = ['pending', 'paid', 'cod'];
  if (!valid.includes(payment_status)) return res.status(400).json({ error: 'Invalid payment status' });
  try {
    const existing = await get('SELECT id FROM orders WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Order not found' });
    if (payment_status === 'paid') {
      const now = new Date().toISOString();
      await run('UPDATE orders SET payment_status = ?, payment_remark = ?, payment_verified_at = ? WHERE id = ?', [payment_status, remark || '', now, req.params.id]);
    } else {
      await run('UPDATE orders SET payment_status = ?, payment_remark = NULL WHERE id = ?', [payment_status, req.params.id]);
    }
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
    const users = await all('SELECT id,email,role,created_at,disabled,disabled_reason,disabled_at FROM users ORDER BY id ASC');
    res.json(users);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: disable/enable a user
app.patch('/api/admin/users/:id/disable', requireAdmin, async (req, res) => {
  try {
    const uid = req.params.id;
    const { disabled, reason } = req.body || {};
    if (typeof disabled !== 'boolean') return res.status(400).json({ error: 'disabled must be boolean' });
    const user = await get('SELECT id FROM users WHERE id = ?', [uid]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (disabled) {
      const now = new Date().toISOString();
      await run('UPDATE users SET disabled = ?, disabled_reason = ?, disabled_at = ? WHERE id = ?', [isPostgres ? true : 1, reason || '', now, uid]);
    } else {
      await run('UPDATE users SET disabled = ?, disabled_reason = NULL, disabled_at = NULL WHERE id = ?', [isPostgres ? false : 0, uid]);
    }
    const updated = await get('SELECT id,email,role,created_at,disabled,disabled_reason,disabled_at FROM users WHERE id = ?', [uid]);
    res.json({ success: true, user: updated });
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

// Admin: upload/replace product image
app.post('/api/admin/products/:id/image', requireAdmin, productUpload.single('image'), async (req, res) => {
  try {
    const productId = req.params.id;
    const existing = await get('SELECT * FROM products WHERE id = ?', [productId]);
    if (!existing) return res.status(404).json({ error: 'Product not found' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    // remove previous image file if on disk and under uploads/products
    if (existing.image) {
      try {
        const prev = existing.image.replace(/^\//, ''); // strip leading /
        const prevPath = path.join(__dirname, prev);
        if (fs.existsSync(prevPath) && prevPath.startsWith(productUploadDir)) fs.unlinkSync(prevPath);
      } catch (e) { /* ignore */ }
    }
    const url = `/uploads/products/${req.file.filename}`;
    await run('UPDATE products SET image = ? WHERE id = ?', [url, productId]);
    res.json({ image: url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: remove product image
app.delete('/api/admin/products/:id/image', requireAdmin, async (req, res) => {
  try {
    const productId = req.params.id;
    const existing = await get('SELECT * FROM products WHERE id = ?', [productId]);
    if (!existing) return res.status(404).json({ error: 'Product not found' });
    if (existing.image) {
      try {
        const prev = existing.image.replace(/^\//, '');
        const prevPath = path.join(__dirname, prev);
        if (fs.existsSync(prevPath) && prevPath.startsWith(productUploadDir)) fs.unlinkSync(prevPath);
      } catch (e) { /* ignore */ }
    }
    await run('UPDATE products SET image = ? WHERE id = ?', ['', productId]);
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
  const {
    customer_name,
    phone,
    address,
    city,
    pincode,
    payment,
    items,
    subtotal,
    delivery,
    total,
    address_id,
    new_address,
    save_address
  } = req.body;
  const orderItems = parseItems(items);

  try {
    // Deny order placement if user is disabled
    const urow = await get('SELECT disabled, disabled_reason FROM users WHERE id = ?', [req.user.id]);
    if (urow && urow.disabled) return res.status(403).json({ error: 'USER_DISABLED', message: urow.disabled_reason || 'This account has been disabled' });
  } catch (ie) {
    // proceed if check fails unexpectedly
    console.warn('Could not verify user disabled state', ie && ie.message ? ie.message : ie);
  }

  if (!customer_name || !phone || !Array.isArray(orderItems) || orderItems.length === 0)
    return res.status(400).json({ error: 'customer_name, phone, and a valid items array are required' });

  let finalAddress = String(address || '').trim();
  let finalCity = String(city || '').trim();
  let finalPincode = String(pincode || '').trim();
  let finalPhone = String(phone || '').trim();
  let finalCustomerName = String(customer_name).trim();
  let finalAddressId = null;

  try {
    if (address_id) {
      const savedAddress = await get('SELECT * FROM addresses WHERE id = ? AND user_id = ?', [address_id, req.user.id]);
      if (!savedAddress) return res.status(400).json({ error: 'Selected address not found' });
      finalAddress = `${savedAddress.line1}${savedAddress.line2 ? ', ' + savedAddress.line2 : ''}`;
      finalCity = savedAddress.city;
      finalPincode = savedAddress.pincode;
      finalPhone = savedAddress.phone;
      finalCustomerName = savedAddress.full_name;
      finalAddressId = savedAddress.id;
    } else if (new_address) {
      const { label, full_name, phone: naPhone, line1, line2, city: naCity, state, pincode: naPincode } = new_address;
      if (!full_name || !naPhone || !line1 || !naCity || !naPincode) {
        return res.status(400).json({ error: 'New address requires full_name, phone, line1, city, and pincode' });
      }
      finalAddress = `${line1.trim()}${line2 ? ', ' + line2.trim() : ''}`;
      finalCity = naCity.trim();
      finalPincode = naPincode.trim();
      finalPhone = naPhone.trim();
      finalCustomerName = full_name.trim();
      if (save_address) {
        if (new_address.is_default) {
          await run('UPDATE addresses SET is_default = ? WHERE user_id = ?', [isPostgres ? false : 0, req.user.id]);
        }
        const inserted = await insert(
          'INSERT INTO addresses (user_id,label,full_name,phone,line1,line2,city,state,pincode,is_default) VALUES (?,?,?,?,?,?,?,?,?,?)',
          [req.user.id, label || '', full_name.trim(), naPhone.trim(), line1.trim(), line2?.trim() || '', naCity.trim(), state?.trim() || '', naPincode.trim(), new_address.is_default ? (isPostgres ? true : 1) : (isPostgres ? false : 0)]
        );
        finalAddressId = inserted.lastID;
      }
    }

    const validPayments = ['upi', 'cod'];
    const paymentMethod = validPayments.includes(payment) ? payment : 'upi';
    const paymentStatus = paymentMethod === 'cod' ? 'cod' : 'pending';

    // Check whether the requested payment method is enabled in server settings
    const pmState = await readPaymentMethods();
    if (!pmState[paymentMethod]) {
      return res.status(400).json({ error: 'PAYMENT_METHOD_DISABLED', message: `Payment method ${paymentMethod} is disabled` });
    }

    // Enforce maximum 2 active COD orders per user
    if (paymentMethod === 'cod') {
      const row = await get("SELECT COUNT(*) AS count FROM orders WHERE user_id = ? AND payment = ? AND status NOT IN ('delivered','cancelled')", [req.user.id, 'cod']);
      const activeCodCount = parseInt(row?.count || 0, 10);
      if (activeCodCount >= 2) {
        return res.status(400).json({ error: 'COD_LIMIT_REACHED', message: 'You already have 2 active COD orders. COD is disabled until those are delivered.' });
      }
    }

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

    console.log('Creating order for user:', req.user?.id, 'items:', orderItems.map(i=>({id:i.id,qty:i.qty}))); 

    const result = await insert(
      'INSERT INTO orders (customer_name,phone,address,city,pincode,payment,payment_status,items,subtotal,delivery,total,user_id,address_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [finalCustomerName, finalPhone, finalAddress, finalCity || '', finalPincode || '', paymentMethod, paymentStatus, JSON.stringify(orderItems), subtotal, delivery || 0, total, req.user.id, finalAddressId]
    );

    // Fetch and return the created order row to ensure fresh id and data
    const created = await get('SELECT * FROM orders WHERE id = ?', [result.lastID]);
    console.log('Order created id=', result.lastID);
    res.status(201).json({ id: result.lastID, order: created ? { ...created, items: parseItems(created.items) } : null, status: 'preparing' });
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
