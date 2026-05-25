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
