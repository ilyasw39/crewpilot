const express = require("express");
const mysql = require("mysql2");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const db = mysql.createConnection({
  host: "localhost",
  user: "root",
  password: "YOUR_PASSWORD",
  database: "crewpilot",
});

db.connect((err) => {
  if (err) {
    console.error("DB connection failed:", err);
    return;
  }
  console.log("Connected to MySQL");
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


// =========================
// EMPLOYEES
// =========================
app.get("/employees", (req, res) => {
  db.query("SELECT * FROM employees", (err, rows) => {
    if (err) return res.status(500).send(err);

    const parsed = rows.map((r) => ({
      ...r,
      availability: r.availability ? JSON.parse(r.availability) : null,
    }));

    res.json(parsed);
  });
});

app.post("/employees", (req, res) => {
  const { name, email, phone, availability } = req.body;

  db.query(
    "INSERT INTO employees (name, email, phone, availability) VALUES (?, ?, ?, ?)",
    [name, email, phone, JSON.stringify(availability || {})],
    (err, result) => {
      if (err) return res.status(500).send(err);
      res.json({ id: result.insertId });
    }
  );
});

app.put("/employees/:id", (req, res) => {
  const { name, email, phone, availability } = req.body;

  db.query(
    "UPDATE employees SET name=?, email=?, phone=?, availability=? WHERE id=?",
    [name, email, phone, JSON.stringify(availability || {}), req.params.id],
    (err) => {
      if (err) return res.status(500).send(err);
      res.sendStatus(200);
    }
  );
});

app.delete("/employees/:id", (req, res) => {
  db.query("DELETE FROM employees WHERE id=?", [req.params.id], (err) => {
    if (err) return res.status(500).send(err);
    res.sendStatus(200);
  });
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
app.listen(3000, () => {
  console.log("Server running on http://localhost:3000");
});