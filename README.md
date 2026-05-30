# 🥭 MangoGrove — Setup Guide

## What's included
```
mangogrove/
├── server.js          ← Backend API (Node.js + Express)
├── package.json       ← Dependencies list
├── README.md          ← This file
└── public/
    └── index.html     ← Full frontend (store + admin)
```
The database file `mangoes.db` is created automatically on first run.

---

## Step 1 — Install Node.js
Download from https://nodejs.org — choose the **LTS** version.
Verify it works: open a terminal and type `node --version`

---

## Step 2 — Install dependencies
Open a terminal, navigate to this folder, and run:
```
npm install
```
This installs Express, SQLite, and CORS (listed in package.json).

---

## Step 3 — Start the server
```
npm start
```
You'll see:
```
🥭 MangoGrove is running!
   Store  → http://localhost:5000
   Admin  → http://localhost:5000  (click Admin in nav)
```

---

## Step 4 — Open in your browser
Go to: http://localhost:5000

The database is created automatically with 6 starter mango varieties.

---

## Email / SMTP configuration (optional but recommended)

The app sends verification and reset codes via email. By default it will create a test (Ethereal) account when no SMTP credentials are provided — this only prints a preview URL to server logs. For real email delivery, set one of the following sets of environment variables before running the server:

- Generic SMTP server:
  - `SMTP_HOST` (e.g. smtp.sendgrid.net)
  - `SMTP_PORT` (e.g. 587 or 465)
  - `SMTP_USER` (username for SMTP auth)
  - `SMTP_PASS` (password for SMTP auth)
  - `SMTP_SECURE` ("true" to use TLS on connect, otherwise "false")
  - `SMTP_FROM` (optional; e.g. "MangoGrove <no-reply@example.com>")

- OR Gmail SMTP (if you prefer Gmail):
  - `GMAIL_USER` (your Gmail address)
  - `GMAIL_PASS` (app password or SMTP password)

If email delivery fails, the server will log detailed errors and return an error to API callers. Example (PowerShell):

```powershell
$env:SMTP_HOST = "smtp.example.com"
$env:SMTP_PORT = "587"
$env:SMTP_USER = "smtp-user"
$env:SMTP_PASS = "smtp-pass"
npm start
```

If you don't set any SMTP variables the server will use an Ethereal test account and log a preview URL that you can open to view the sent message.


---

## Admin panel
Click **Admin ⚙️** in the navigation bar.

- **Products tab** — add, edit, delete mango varieties
- **Orders tab** — view all customer orders, update status (Preparing → Shipped → Delivered)
- **Stock Manager** — add or remove stock in bulk (e.g. +100 kg new harvest)

---

## What the database stores
| Table        | What it holds                              |
|--------------|--------------------------------------------|
| `products`   | Mango varieties, prices, stock levels      |
| `orders`     | Customer orders with items and status      |
| `stock_log`  | Every stock change (order deductions + manual updates) |

To view the database visually, download **DB Browser for SQLite** (free): https://sqlitebrowser.org
Open `mangoes.db` with it.

---

## To stop the server
Press `Ctrl + C` in the terminal.

## To restart
Run `npm start` again — all your data is saved in `mangoes.db`.
