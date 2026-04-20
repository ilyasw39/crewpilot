const express = require("express");
const mysql = require("mysql2");
const cors = require("cors");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const db = mysql.createConnection({
  host: process.env.MYSQL_PUBLIC_URL.split("@")[1].split(":")[0],
  user: process.env.MYSQL_PUBLIC_URL.split("//")[1].split(":")[0],
  password: process.env.MYSQL_PUBLIC_URL.split(":")[2].split("@")[0],
  database: process.env.MYSQL_PUBLIC_URL.split("/").pop(),
  port: process.env.MYSQL_PUBLIC_URL.split(":")[3].split("/")[0],
  ssl: {
    rejectUnauthorized: false,
  },
});
const dbp = db.promise();

async function mockAuth(req, res, next) {
  const userId = 1; // TEMP (Jess)
  try {
    const [rows] = await dbp.execute(
      "SELECT store_id, role FROM store_members WHERE user_id = ? LIMIT 1",
      [userId]
    );
    req.user = {
      id: userId,
      storeId: rows[0]?.store_id || null,
      role: rows[0]?.role || null,
    };
    next();
  } catch (err) {
    next(err);
  }
}

function requireStore(req, res, next) {
  if (!req.user || !req.user.storeId) {
    return res.status(403).json({ error: "No store linked to current user" });
  }
  next();
}

db.connect((err) => {
  if (err) {
    console.error("DB connection failed:", err);
    return;
  }
  console.log("Connected to MySQL");
  db.query(
    `CREATE TABLE IF NOT EXISTS stores (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL
    )`,
    (storesErr) => {
      if (storesErr) console.error("Could not ensure stores table:", storesErr);
    }
  );
  db.query(
    `CREATE TABLE IF NOT EXISTS store_members (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      store_id INT NOT NULL,
      role VARCHAR(50) NOT NULL,
      UNIQUE KEY uq_user_store (user_id, store_id)
    )`,
    (membersErr) => {
      if (membersErr) {
        console.error("Could not ensure store_members table:", membersErr);
      }
    }
  );
});


// =========================
// AUTH (LOGIN)
// =========================
app.post("/login", (req, res) => {
  const { username, password } = req.body;

  db.query(
    "SELECT * FROM users WHERE username=? AND password=?",
    [username, password],
    (err, results) => {
      if (err) return res.status(500).send(err);

      if (results.length === 0) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      const user = results[0];

      res.json({
        id: user.id,
        username: user.username,
        role: user.role,
        employee_id: user.employee_id,
      });
    }
  );
});

app.use("/me", mockAuth);

app.get("/me/store", async (req, res) => {
  try {
    const [rows] = await dbp.execute(
      "SELECT store_id, role FROM store_members WHERE user_id = ? LIMIT 1",
      [req.user.id]
    );

    if (rows.length === 0) {
      return res.json(null);
    }

    return res.json(rows[0]);
  } catch (err) {
    return res.status(500).send(err.message);
  }
});

app.post("/me/store", async (req, res) => {
  const { name } = req.body || {};
  const cleanName = String(name || "").trim();
  if (!cleanName) {
    return res.status(400).send("Store name is required");
  }

  try {
    const [existing] = await dbp.execute(
      "SELECT store_id FROM store_members WHERE user_id = ? LIMIT 1",
      [req.user.id]
    );
    if (existing.length > 0) {
      return res.status(409).json({ storeId: existing[0].store_id });
    }

    const [storeResult] = await dbp.execute(
      "INSERT INTO stores (name) VALUES (?)",
      [cleanName]
    );
    const storeId = storeResult.insertId;

    await dbp.execute(
      "INSERT INTO store_members (user_id, store_id, role) VALUES (?, ?, 'owner')",
      [req.user.id, storeId]
    );

    return res.json({ storeId });
  } catch (err) {
    console.error(err);
    return res.status(500).send(err.message);
  }
});


// =========================
// EMPLOYEES
// =========================
app.get("/me/employees", requireStore, (req, res) => {
  db.query("SELECT * FROM employees WHERE store_id = ?", [req.user.storeId], (err, rows) => {
    if (err) return res.status(500).send(err);

    const parsed = rows.map((r) => ({
      ...r,
      availability: r.availability ? JSON.parse(r.availability) : null,
    }));

    res.json(parsed);
  });
});

app.post("/me/employees", requireStore, (req, res) => {
  const { name, email, phone, role, availability } = req.body;

  db.query(
    "INSERT INTO employees (store_id, name, email, phone, role, availability) VALUES (?, ?, ?, ?, ?, ?)",
    [
      req.user.storeId,
      name,
      email,
      phone,
      role || "employee",
      JSON.stringify(availability || {}),
    ],
    (err, result) => {
      if (err) return res.status(500).send(err);
      res.json({ id: result.insertId });
    }
  );
});

app.put("/me/employees/:id", requireStore, (req, res) => {
  const { name, email, phone, role, availability } = req.body;

  db.query(
    "UPDATE employees SET name=?, email=?, phone=?, role=?, availability=? WHERE id=? AND store_id=?",
    [
      name,
      email,
      phone,
      role,
      JSON.stringify(availability || {}),
      req.params.id,
      req.user.storeId,
    ],
    (err, result) => {
      if (err) return res.status(500).send(err);
      if (!result.affectedRows) return res.status(404).send("Employee not found");
      res.sendStatus(200);
    }
  );
});

app.delete("/me/employees/:id", requireStore, (req, res) => {
  db.query(
    "DELETE FROM employees WHERE id=? AND store_id=?",
    [req.params.id, req.user.storeId],
    (err, result) => {
    if (err) return res.status(500).send(err);
    if (!result.affectedRows) return res.status(404).send("Employee not found");
    res.sendStatus(200);
    }
  );
});


// =========================
// SHIFTS
// =========================
app.get("/shifts", (req, res) => {
  db.query("SELECT * FROM shifts ORDER BY start ASC", (err, rows) => {
    if (err) return res.status(500).send(err);
    res.json(rows);
  });
});

app.post("/shifts", (req, res) => {
  const { employee_id, start, end, type } = req.body;

  if (!employee_id) return res.status(400).send("employee_id required");

  db.query(
    "INSERT INTO shifts (employee_id, start, end, type) VALUES (?, ?, ?, ?)",
    [employee_id, start, end, type || "Open"],
    (err, result) => {
      if (err) return res.status(500).send(err);
      res.json({ id: result.insertId });
    }
  );
});

app.put("/shifts/:id", (req, res) => {
  const { employee_id, start, end, type } = req.body;

  db.query(
    "UPDATE shifts SET employee_id=?, start=?, end=?, type=? WHERE id=?",
    [employee_id, start, end, type || "Open", req.params.id],
    (err) => {
      if (err) return res.status(500).send(err);
      res.sendStatus(200);
    }
  );
});

app.delete("/shifts/:id", (req, res) => {
  db.query("DELETE FROM shifts WHERE id=?", [req.params.id], (err) => {
    if (err) return res.status(500).send(err);
    res.sendStatus(200);
  });
});


// =========================
// SHIFT POOL (SWAPS)
// =========================
app.get("/shift-pool", (req, res) => {
  db.query(
    `SELECT sp.*, s.start, s.end, s.type 
     FROM shift_pool sp
     JOIN shifts s ON sp.shift_id = s.id`,
    (err, rows) => {
      if (err) return res.status(500).send(err);
      res.json(rows);
    }
  );
});


// Offer shift
app.post("/shift-pool", (req, res) => {
  const { shift_id, created_by } = req.body;

  if (!shift_id) return res.status(400).send("shift_id required");

  db.query(
    "INSERT INTO shift_pool (shift_id, created_by, status) VALUES (?, ?, 'open')",
    [shift_id, created_by || null],
    (err, result) => {
      if (err) return res.status(500).send(err);
      res.json({ id: result.insertId });
    }
  );
});


// Take / approve / reject
app.put("/shift-pool/:id", (req, res) => {
  const { requested_by, status } = req.body;

  db.query(
    "UPDATE shift_pool SET requested_by=?, status=? WHERE id=?",
    [requested_by || null, status, req.params.id],
    (err) => {
      if (err) return res.status(500).send(err);

      // 🔥 IMPORTANT: update shift when approved
      if (status === "approved" && requested_by) {
        db.query(
          `UPDATE shifts 
           SET employee_id=? 
           WHERE id = (SELECT shift_id FROM shift_pool WHERE id=?)`,
          [requested_by, req.params.id],
          (err2) => {
            if (err2) return res.status(500).send(err2);
            res.sendStatus(200);
          }
        );
      } else {
        res.sendStatus(200);
      }
    }
  );
});


// Remove from pool
app.delete("/shift-pool/:id", (req, res) => {
  db.query("DELETE FROM shift_pool WHERE id=?", [req.params.id], (err) => {
    if (err) return res.status(500).send(err);
    res.sendStatus(200);
  });
});


// =========================
// SENT DAYS (GREEN DOTS)
// =========================
app.get("/sent-days", (req, res) => {
  db.query("SELECT date FROM sent_days", (err, rows) => {
    if (err) return res.status(500).send(err);

    const dates = rows.map((r) =>
      r.date instanceof Date
        ? r.date.toISOString().slice(0, 10)
        : r.date
    );

    res.json(dates);
  });
});

app.post("/sent-days", (req, res) => {
  const { date, sent_by } = req.body;

  if (!date) return res.status(400).send("date required");

  db.query(
    "INSERT INTO sent_days (date, sent_by) VALUES (?, ?) ON DUPLICATE KEY UPDATE sent_by=VALUES(sent_by)",
    [date, sent_by || null],
    (err) => {
      if (err) return res.status(500).send(err);
      res.sendStatus(200);
    }
  );
});

app.delete("/sent-days/:date", (req, res) => {
  db.query("DELETE FROM sent_days WHERE date=?", [req.params.date], (err) => {
    if (err) return res.status(500).send(err);
    res.sendStatus(200);
  });
});


// =========================
// SERVER
// =========================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});