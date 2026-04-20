const express = require("express");
const mysql = require("mysql2");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const cors = require("cors");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const url = new URL(process.env.MYSQL_PUBLIC_URL);
const db = mysql.createConnection({
  host: url.hostname,
  user: url.username,
  password: url.password,
  database: url.pathname.replace("/", ""),
  port: url.port,
  ssl: {
    rejectUnauthorized: false,
  },
});
const dbp = db.promise();
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error("JWT_SECRET missing");
}
const sendData = (res, data, status = 200) => res.status(status).json({ data });
const sendError = (res, status, message) => res.status(status).json({ error: message });
const API_PREFIX = "/api/v1";
function registerRoute(method, path, ...handlers) {
  app[method](path, ...handlers);
  app[method](`${API_PREFIX}${path}`, ...handlers);
}
function registerRouteAliases(method, paths, ...handlers) {
  paths.forEach((path) => {
    app[method](path, ...handlers);
    app[method](`${API_PREFIX}${path}`, ...handlers);
  });
}

async function auth(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) {
    return sendError(res, 401, "No token");
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const userId = Number(decoded.userId);
    if (!Number.isFinite(userId) || userId <= 0) {
      return sendError(res, 401, "Invalid token payload");
    }
    const [rows] = await dbp.execute(
      "SELECT store_id, role FROM store_members WHERE user_id = ? LIMIT 1",
      [userId]
    );
    req.user = {
      id: Number(userId),
      storeId: rows[0]?.store_id || null,
      role: rows[0]?.role || null,
    };
    next();
  } catch (err) {
    if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError") {
      return sendError(res, 401, "Invalid token");
    }
    return next(err);
  }
}

function requireStore(req, res, next) {
  if (!req.user || !req.user.storeId) {
    return sendError(res, 403, "No store linked to current user");
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
// AUTH
// =========================
async function loginHandler(req, res) {
  const { username, password } = req.body;
  if (!username || !password) {
    return sendError(res, 400, "username and password are required");
  }

  try {
    const [results] = await dbp.execute("SELECT * FROM users WHERE username=?", [
      username,
    ]);
    if (!results || results.length === 0) {
      return sendError(res, 401, "Invalid credentials");
    }

    const user = results[0];
    const storedPassword = String(user.password || "");
    let passwordOk = false;
    if (storedPassword.startsWith("$2")) {
      passwordOk = await bcrypt.compare(password, storedPassword);
    } else {
      // Backward-compatible fallback for pre-hash users.
      passwordOk = storedPassword === password;
      if (passwordOk) {
        const upgradedHash = await bcrypt.hash(password, 10);
        await dbp.execute("UPDATE users SET password=? WHERE id=?", [
          upgradedHash,
          user.id,
        ]);
      }
    }
    if (!passwordOk) {
      return sendError(res, 401, "Invalid credentials");
    }

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, {
      expiresIn: "7d",
    });

    return sendData(res, {
      token,
      userId: user.id,
      id: user.id,
      username: user.username,
      role: user.role,
      employee_id: user.employee_id,
    });
  } catch (err) {
    return sendError(res, 500, "login failed");
  }
}

async function createStoreHandler(req, res) {
  const { username, password, storeName } = req.body || {};

  if (!username || !password || !storeName) {
    return sendError(res, 400, "username, password, and storeName are required");
  }

  try {
    // 1. create user
    const hashedPassword = await bcrypt.hash(password, 10);
    const [userResult] = await dbp.query(
      "INSERT INTO users (username, password, role) VALUES (?, ?, 'owner')",
      [username, hashedPassword]
    );

    const userId = userResult.insertId;

    // 2. create store
    const [storeResult] = await dbp.query(
      "INSERT INTO stores (name) VALUES (?)",
      [storeName]
    );

    const storeId = storeResult.insertId;

    // 3. link user -> store
    await dbp.query(
      "INSERT INTO store_members (user_id, store_id, role) VALUES (?, ?, 'owner')",
      [userId, storeId]
    );
    const token = jwt.sign({ userId }, JWT_SECRET, { expiresIn: "7d" });

    // 4. return success and token for immediate sign-in
    return sendData(res, { success: true, userId, storeId, token });
  } catch (err) {
    console.error(err);
    return sendError(res, 500, "failed to create store");
  }
}

registerRouteAliases("post", ["/auth/login", "/login"], loginHandler);
registerRouteAliases(
  "post",
  ["/auth/register", "/create-store"],
  createStoreHandler
);

app.use("/me", auth);
app.use(`${API_PREFIX}/me`, auth);

registerRoute("get", "/me", (req, res) => {
  return sendData(res, {
    id: req.user.id,
    storeId: req.user.storeId,
    role: req.user.role,
  });
});

registerRoute("get", "/health", (req, res) => {
  return sendData(res, { status: "ok" });
});

registerRoute("get", "/me/store", async (req, res) => {
  try {
    const [rows] = await dbp.execute(
      "SELECT store_id, role FROM store_members WHERE user_id = ? LIMIT 1",
      [req.user.id]
    );

    if (rows.length === 0) {
      return sendData(res, null);
    }

    return sendData(res, rows[0]);
  } catch (err) {
    return sendError(res, 500, err.message);
  }
});


// =========================
// EMPLOYEES
// =========================
registerRoute("get", "/me/employees", requireStore, (req, res) => {
  db.query("SELECT * FROM employees WHERE store_id = ?", [req.user.storeId], (err, rows) => {
    if (err) return sendError(res, 500, err.message);

    const parsed = rows.map((r) => ({
      ...r,
      availability: r.availability ? JSON.parse(r.availability) : null,
    }));

    return sendData(res, parsed);
  });
});

registerRoute("post", "/me/employees", requireStore, (req, res) => {
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
      if (err) return sendError(res, 500, err.message);
      return sendData(res, { id: result.insertId });
    }
  );
});

registerRoute("put", "/me/employees/:id", requireStore, (req, res) => {
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
      if (err) return sendError(res, 500, err.message);
      if (!result.affectedRows) return sendError(res, 404, "Employee not found");
      return sendData(res, { success: true });
    }
  );
});

registerRoute("delete", "/me/employees/:id", requireStore, (req, res) => {
  db.query(
    "DELETE FROM employees WHERE id=? AND store_id=?",
    [req.params.id, req.user.storeId],
    (err, result) => {
    if (err) return sendError(res, 500, err.message);
    if (!result.affectedRows) return sendError(res, 404, "Employee not found");
    return sendData(res, { success: true });
    }
  );
});


// =========================
// SHIFTS
// =========================
registerRoute("get", "/shifts", (req, res) => {
  db.query("SELECT * FROM shifts ORDER BY start ASC", (err, rows) => {
    if (err) return sendError(res, 500, err.message);
    return sendData(res, rows);
  });
});

registerRoute("post", "/shifts", (req, res) => {
  const { employee_id, start, end, type } = req.body;

  if (!employee_id) return sendError(res, 400, "employee_id required");

  db.query(
    "INSERT INTO shifts (employee_id, start, end, type) VALUES (?, ?, ?, ?)",
    [employee_id, start, end, type || "Open"],
    (err, result) => {
      if (err) return sendError(res, 500, err.message);
      return sendData(res, { id: result.insertId });
    }
  );
});

registerRoute("put", "/shifts/:id", (req, res) => {
  const { employee_id, start, end, type } = req.body;

  db.query(
    "UPDATE shifts SET employee_id=?, start=?, end=?, type=? WHERE id=?",
    [employee_id, start, end, type || "Open", req.params.id],
    (err) => {
      if (err) return sendError(res, 500, err.message);
      return sendData(res, { success: true });
    }
  );
});

registerRoute("delete", "/shifts/:id", (req, res) => {
  db.query("DELETE FROM shifts WHERE id=?", [req.params.id], (err) => {
    if (err) return sendError(res, 500, err.message);
    return sendData(res, { success: true });
  });
});


// =========================
// SHIFT POOL (SWAPS)
// =========================
registerRoute("get", "/shift-pool", (req, res) => {
  db.query(
    `SELECT sp.*, s.start, s.end, s.type 
     FROM shift_pool sp
     JOIN shifts s ON sp.shift_id = s.id`,
    (err, rows) => {
      if (err) return sendError(res, 500, err.message);
      return sendData(res, rows);
    }
  );
});


// Offer shift
registerRoute("post", "/shift-pool", (req, res) => {
  const { shift_id, created_by } = req.body;

  if (!shift_id) return sendError(res, 400, "shift_id required");

  db.query(
    "INSERT INTO shift_pool (shift_id, created_by, status) VALUES (?, ?, 'open')",
    [shift_id, created_by || null],
    (err, result) => {
      if (err) return sendError(res, 500, err.message);
      return sendData(res, { id: result.insertId });
    }
  );
});


// Take / approve / reject
registerRoute("put", "/shift-pool/:id", (req, res) => {
  const { requested_by, status } = req.body;

  db.query(
    "UPDATE shift_pool SET requested_by=?, status=? WHERE id=?",
    [requested_by || null, status, req.params.id],
    (err) => {
      if (err) return sendError(res, 500, err.message);

      // 🔥 IMPORTANT: update shift when approved
      if (status === "approved" && requested_by) {
        db.query(
          `UPDATE shifts 
           SET employee_id=? 
           WHERE id = (SELECT shift_id FROM shift_pool WHERE id=?)`,
          [requested_by, req.params.id],
          (err2) => {
            if (err2) return sendError(res, 500, err2.message);
            return sendData(res, { success: true });
          }
        );
      } else {
        return sendData(res, { success: true });
      }
    }
  );
});


// Remove from pool
registerRoute("delete", "/shift-pool/:id", (req, res) => {
  db.query("DELETE FROM shift_pool WHERE id=?", [req.params.id], (err) => {
    if (err) return sendError(res, 500, err.message);
    return sendData(res, { success: true });
  });
});


// =========================
// SENT DAYS (GREEN DOTS)
// =========================
registerRoute("get", "/sent-days", (req, res) => {
  db.query("SELECT date FROM sent_days", (err, rows) => {
    if (err) return sendError(res, 500, err.message);

    const dates = rows.map((r) =>
      r.date instanceof Date
        ? r.date.toISOString().slice(0, 10)
        : r.date
    );

    return sendData(res, dates);
  });
});

registerRoute("post", "/sent-days", (req, res) => {
  const { date, sent_by } = req.body;

  if (!date) return sendError(res, 400, "date required");

  db.query(
    "INSERT INTO sent_days (date, sent_by) VALUES (?, ?) ON DUPLICATE KEY UPDATE sent_by=VALUES(sent_by)",
    [date, sent_by || null],
    (err) => {
      if (err) return sendError(res, 500, err.message);
      return sendData(res, { success: true });
    }
  );
});

registerRoute("delete", "/sent-days/:date", (req, res) => {
  db.query("DELETE FROM sent_days WHERE date=?", [req.params.date], (err) => {
    if (err) return sendError(res, 500, err.message);
    return sendData(res, { success: true });
  });
});


// =========================
// SERVER
// =========================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});