const express = require("express");
const mysql = require("mysql2");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many auth attempts, try again later" },
});

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

function parseEmployeeAvailability(value) {
  if (value == null || value === "") return null;
  try {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value;
    }
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

const EMPLOYEE_ROLES = ["employee", "Key Holder", "Non-Key Holder", "owner", "manager"];

/** Allowed `shift_pool.status` values for PUT /shift-pool/:id */
const SHIFT_POOL_STATUSES = ["posted", "claimed", "approved"];

/** Allowed `swap_requests.status` values for PUT /swap-requests/:id */
const SWAP_REQUEST_PUT_STATUSES = ["awaiting_approval", "approved", "rejected"];

function normalizeEmployeeRole(role) {
  const r = String(role || "").trim();
  return EMPLOYEE_ROLES.includes(r) ? r : "employee";
}

const v1Router = express.Router();

function registerMeSubroutes(me) {
  me.get("/", (req, res) => {
    return sendData(res, {
      id: req.user.id,
      storeId: req.user.storeId,
      role: req.user.role,
      employeeId: req.user.employeeId,
    });
  });

  me.get("/store", (req, res) => {
    if (!req.user.storeId) {
      return sendData(res, null);
    }
    return sendData(res, {
      store_id: req.user.storeId,
      role: req.user.role,
    });
  });

  me.get("/employees", requireStore, (req, res) => {
    db.query("SELECT * FROM employees WHERE store_id = ?", [req.user.storeId], (err, rows) => {
      if (err) return sendError(res, 500, err.message);

      const parsed = rows.map((r) => ({
        ...r,
        availability: parseEmployeeAvailability(r.availability),
      }));

      return sendData(res, parsed);
    });
  });

  me.post("/employees", requireStore, async (req, res) => {
    const { user_id, name, email, phone, role, availability } = req.body;

    const cleanName = String(name || "").trim();
    const cleanEmail = email == null || email === "" ? null : String(email).trim();
    const cleanPhone = phone == null || phone === "" ? null : String(phone).trim();

    if (!cleanName) {
      return sendError(res, 400, "name required");
    }

    let uid = null;

    try {
      if (!(user_id === undefined || user_id === null || user_id === "")) {
        uid = Number(user_id);
        if (!Number.isFinite(uid) || uid <= 0) {
          return sendError(res, 400, "invalid user_id");
        }

        const [userCheck] = await dbp.execute(
          "SELECT id FROM users WHERE id = ? LIMIT 1",
          [uid]
        );
        if (!userCheck.length) {
          return sendError(res, 400, "user does not exist");
        }

        const [existing] = await dbp.execute(
          "SELECT id FROM employees WHERE user_id = ? AND store_id = ? LIMIT 1",
          [uid, req.user.storeId]
        );
        if (existing.length) {
          return sendError(res, 409, "user already has an employee profile in this store");
        }
      }

      const [insertHeader] = await dbp.execute(
        "INSERT INTO employees (user_id, store_id, name, email, phone, role, availability) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
          uid,
          req.user.storeId,
          cleanName,
          cleanEmail,
          cleanPhone,
          normalizeEmployeeRole(role),
          JSON.stringify(availability || {}),
        ]
      );
      return sendData(res, { id: insertHeader.insertId });
    } catch (err) {
      return sendError(res, 500, err.message);
    }
  });

  me.put("/employees/:id", requireStore, (req, res) => {
    const { name, email, phone, role, availability } = req.body;

    const cleanName = String(name || "").trim();
    const cleanEmail = email == null || email === "" ? null : String(email).trim();
    const cleanPhone = phone == null || phone === "" ? null : String(phone).trim();

    if (!cleanName) {
      return sendError(res, 400, "name required");
    }

    db.query(
      "UPDATE employees SET name=?, email=?, phone=?, role=?, availability=? WHERE id=? AND store_id=?",
      [
        cleanName,
        cleanEmail,
        cleanPhone,
        normalizeEmployeeRole(role),
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

  me.delete("/employees/:id", requireStore, (req, res) => {
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
}

/**
 * CrewPilot API — scheduling routes (store-scoped; employees as scheduling actors; revision on bulk).
 * - Tenant: all data scoped by req.user.storeId; auth uses users.id, scheduling uses employees.id.
 * - Shifts: canonical schedule; bulk save uses stores.shifts_revision (409 on mismatch).
 * - Swap exclusivity: a shift cannot have an active direct swap AND pool pipeline at once.
 * - Finalization: reassign shift, clear competing swap_requests + shift_pool, bump revision where applicable.
 */
function registerResourceRoutes(r) {
  r.get("/shifts", auth, requireStore, async (req, res) => {
    try {
      const [revRows] = await dbp.execute(
        "SELECT shifts_revision FROM stores WHERE id = ? LIMIT 1",
        [req.user.storeId]
      );
      const revision =
        revRows[0]?.shifts_revision != null ? Number(revRows[0].shifts_revision) : 0;

      const [rows] = await dbp.execute(
        "SELECT * FROM shifts WHERE store_id = ? ORDER BY start_time ASC",
        [req.user.storeId]
      );
      const mapped = (rows || []).map((r) => ({
        ...r,
        start: r.start_time,
        end: r.end_time,
      }));
      return sendData(res, { revision, shifts: mapped });
    } catch (err) {
      return sendError(res, 500, err.message);
    }
  });

  r.post("/shifts", auth, requireStore, async (req, res) => {
    const { employee_id } = req.body;
    const start_time = String(req.body.start_time ?? req.body.start ?? "").trim();
    const end_time = String(req.body.end_time ?? req.body.end ?? "").trim();

    if (!employee_id) return sendError(res, 400, "employee_id required");
    if (!start_time || !end_time) {
      return sendError(res, 400, "start_time and end_time required");
    }
    const timeErr = assertShiftEndAfterStart(start_time, end_time);
    if (timeErr) return sendError(res, 400, timeErr);

    const eidPost = Number(employee_id);
    if (!Number.isFinite(eidPost) || eidPost <= 0) {
      return sendError(res, 400, "invalid employee_id");
    }

    try {
      const [empRows] = await dbp.execute(
        "SELECT id FROM employees WHERE id = ? AND store_id = ? LIMIT 1",
        [eidPost, req.user.storeId]
      );
      if (!empRows.length) {
        return sendError(res, 400, "employee not in store");
      }

      const [result] = await dbp.query(
        "INSERT INTO shifts (employee_id, start_time, end_time, store_id) VALUES (?, ?, ?, ?)",
        [eidPost, start_time, end_time, req.user.storeId]
      );
      await bumpShiftsRevisionForStore(req.user.storeId);
      const [revAfter] = await dbp.execute(
        "SELECT shifts_revision FROM stores WHERE id = ? LIMIT 1",
        [req.user.storeId]
      );
      return sendData(res, {
        id: result.insertId,
        revision: Number(revAfter[0]?.shifts_revision ?? 0),
      });
    } catch (err) {
      return sendError(res, 500, err.message);
    }
  });

  r.put("/shifts/bulk", auth, requireStore, async (req, res) => {
    if (Array.isArray(req.body)) {
      return sendError(
        res,
        400,
        "expected { shifts: [...], revision: number }; reload the schedule page if you see this"
      );
    }
    if (!req.body || !Array.isArray(req.body.shifts)) {
      return sendError(res, 400, "expected { shifts: [...], revision: number }");
    }

    const items = req.body.shifts;
    const clientRevision = Number(req.body.revision);
    if (!Number.isFinite(clientRevision) || clientRevision < 0) {
      return sendError(res, 400, "revision must be a non-negative integer matching GET /shifts");
    }

    const storeId = req.user.storeId;

    const normalized = items.map((raw) => {
      const id = raw.id != null ? Number(raw.id) : null;
      const employee_id = Number(raw.employee_id ?? raw.employeeId);
      const start_time = String(raw.start_time ?? raw.start ?? "").trim();
      const end_time = String(raw.end_time ?? raw.end ?? "").trim();
      return { id, employee_id, start_time, end_time };
    });

    for (const row of normalized) {
      if (!Number.isFinite(row.employee_id) || row.employee_id <= 0) {
        return sendError(res, 400, "each shift needs a valid employee_id");
      }
      if (!row.start_time || !row.end_time) {
        return sendError(res, 400, "each shift needs start and end times");
      }
    }

    try {
      const empIds = [...new Set(normalized.map((r) => r.employee_id))];
      for (const eid of empIds) {
        const [er] = await dbp.execute(
          "SELECT id FROM employees WHERE id = ? AND store_id = ? LIMIT 1",
          [eid, storeId]
        );
        if (!er.length) {
          return sendError(res, 400, "employee not in store");
        }
      }

      const overlapErr = assertNoEmployeeShiftOverlaps(normalized);
      if (overlapErr) {
        return sendError(res, 400, overlapErr);
      }

      const [existingRows] = await dbp.execute("SELECT id FROM shifts WHERE store_id = ?", [storeId]);
      const existingIds = new Set(existingRows.map((r) => r.id));
      const incomingPersistedIds = new Set(
        normalized.filter((r) => r.id != null && Number.isFinite(r.id) && r.id > 0).map((r) => r.id)
      );

      await dbp.beginTransaction();
      try {
        const [revLock] = await dbp.execute(
          "SELECT shifts_revision FROM stores WHERE id = ? FOR UPDATE",
          [storeId]
        );
        const currentRev = Number(revLock[0]?.shifts_revision ?? 0);
        if (clientRevision !== currentRev) {
          await dbp.rollback();
          return sendError(
            res,
            409,
            "shifts were modified elsewhere; reload the schedule and try again"
          );
        }

        for (const id of existingIds) {
          if (!incomingPersistedIds.has(id)) {
            await dbp.execute("DELETE FROM shifts WHERE id = ? AND store_id = ?", [id, storeId]);
          }
        }

        for (const row of normalized) {
          if (row.id != null && Number.isFinite(row.id) && row.id > 0) {
            const [upd] = await dbp.execute(
              "UPDATE shifts SET employee_id = ?, start_time = ?, end_time = ? WHERE id = ? AND store_id = ?",
              [row.employee_id, row.start_time, row.end_time, row.id, storeId]
            );
            if (!upd.affectedRows) {
              await dbp.rollback();
              return sendError(res, 400, `shift ${row.id} not found in store`);
            }
          } else {
            await dbp.execute(
              "INSERT INTO shifts (employee_id, start_time, end_time, store_id) VALUES (?, ?, ?, ?)",
              [row.employee_id, row.start_time, row.end_time, storeId]
            );
          }
        }

        await dbp.execute(
          "UPDATE stores SET shifts_revision = shifts_revision + 1 WHERE id = ?",
          [storeId]
        );
        const [revOut] = await dbp.execute(
          "SELECT shifts_revision FROM stores WHERE id = ? LIMIT 1",
          [storeId]
        );

        await dbp.commit();
        return sendData(res, {
          success: true,
          revision: Number(revOut[0]?.shifts_revision ?? currentRev + 1),
        });
      } catch (e) {
        await dbp.rollback();
        return sendError(res, 500, e.message);
      }
    } catch (err) {
      return sendError(res, 500, err.message);
    }
  });

  r.put("/shifts/:id", auth, requireStore, async (req, res) => {
    const { employee_id } = req.body;
    const start_time = String(req.body.start_time ?? req.body.start ?? "").trim();
    const end_time = String(req.body.end_time ?? req.body.end ?? "").trim();

    if (!start_time || !end_time) {
      return sendError(res, 400, "start_time and end_time required");
    }
    const timeErrPut = assertShiftEndAfterStart(start_time, end_time);
    if (timeErrPut) return sendError(res, 400, timeErrPut);

    const eid =
      employee_id === undefined || employee_id === null || employee_id === ""
        ? null
        : Number(employee_id);
    if (eid !== null && (!Number.isFinite(eid) || eid <= 0)) {
      return sendError(res, 400, "invalid employee_id");
    }

    try {
      if (eid !== null) {
        const [empRows] = await dbp.execute(
          "SELECT id FROM employees WHERE id = ? AND store_id = ? LIMIT 1",
          [eid, req.user.storeId]
        );
        if (!empRows.length) {
          return sendError(res, 400, "employee not in store");
        }
      }

      const [result] = await dbp.execute(
        "UPDATE shifts SET employee_id=?, start_time=?, end_time=? WHERE id=? AND store_id=?",
        [eid, start_time, end_time, req.params.id, req.user.storeId]
      );
      if (!result.affectedRows) return sendError(res, 404, "shift not found");
      await bumpShiftsRevisionForStore(req.user.storeId);
      const [revAfter] = await dbp.execute(
        "SELECT shifts_revision FROM stores WHERE id = ? LIMIT 1",
        [req.user.storeId]
      );
      return sendData(res, {
        success: true,
        revision: Number(revAfter[0]?.shifts_revision ?? 0),
      });
    } catch (err) {
      return sendError(res, 500, err.message);
    }
  });

  r.delete("/shifts/:id", auth, requireStore, async (req, res) => {
    try {
      const [result] = await dbp.execute("DELETE FROM shifts WHERE id=? AND store_id=?", [
        req.params.id,
        req.user.storeId,
      ]);
      if (!result.affectedRows) return sendError(res, 404, "shift not found");
      await bumpShiftsRevisionForStore(req.user.storeId);
      const [revAfter] = await dbp.execute(
        "SELECT shifts_revision FROM stores WHERE id = ? LIMIT 1",
        [req.user.storeId]
      );
      return sendData(res, {
        success: true,
        revision: Number(revAfter[0]?.shifts_revision ?? 0),
      });
    } catch (err) {
      return sendError(res, 500, err.message);
    }
  });

  r.get("/shift-pool", auth, requireStore, (req, res) => {
    db.query(
      `SELECT sp.*, s.start_time AS shift_start, s.end_time AS shift_end, NULL AS shift_type
       FROM shift_pool sp
       INNER JOIN shifts s ON s.id = sp.shift_id AND s.store_id = ?`,
      [req.user.storeId],
      (err, rows) => {
        if (err) return sendError(res, 500, err.message);
        return sendData(res, rows);
      }
    );
  });

  r.post("/shift-pool", auth, requireStore, async (req, res) => {
    const { shift_id } = req.body;

    if (!shift_id) return sendError(res, 400, "shift_id required");

    const sid = Number(shift_id);
    if (!Number.isFinite(sid) || sid <= 0) {
      return sendError(res, 400, "invalid shift_id");
    }

    try {
      const created_by = req.user.employeeId;
      if (created_by == null) {
        return sendError(
          res,
          400,
          "Account must be linked to an employee profile to post to the shift pool"
        );
      }

      const [empRows] = await dbp.execute(
        "SELECT id FROM employees WHERE id = ? AND store_id = ? LIMIT 1",
        [created_by, req.user.storeId]
      );
      if (!empRows.length) {
        return sendError(res, 403, "Employee not in this store");
      }

      const [poolDup] = await dbp.execute(
        `SELECT sp.id FROM shift_pool sp
         INNER JOIN shifts s ON s.id = sp.shift_id AND s.store_id = ?
         WHERE sp.shift_id = ? AND sp.status IN ('posted', 'claimed')
         LIMIT 1`,
        [req.user.storeId, sid]
      );
      if (poolDup.length) {
        return sendError(res, 409, "this shift is already in the swap pool");
      }

      const [swapActive] = await dbp.execute(
        `SELECT sr.id
         FROM swap_requests sr
         INNER JOIN shifts s ON s.id = sr.shift_id
         WHERE sr.shift_id = ?
         AND s.store_id = ?
         AND sr.status IN ('pending', 'awaiting_approval')
         LIMIT 1`,
        [sid, req.user.storeId]
      );
      if (swapActive.length) {
        return sendError(res, 409, "this shift has an active direct swap request");
      }

      const [result] = await dbp.query(
        `INSERT INTO shift_pool (shift_id, created_by, status)
         SELECT ?, ?, 'posted'
         FROM shifts s
         WHERE s.id = ? AND s.store_id = ? AND s.employee_id = ?
         LIMIT 1`,
        [sid, created_by, sid, req.user.storeId, created_by]
      );
      if (!result.affectedRows) {
        return sendError(
          res,
          404,
          "shift not found, not in your store, or you are not the assigned employee"
        );
      }
      return sendData(res, { id: result.insertId });
    } catch (err) {
      return sendError(res, 500, err.message);
    }
  });

  r.put("/shift-pool/:id", auth, requireStore, async (req, res) => {
    const { status } = req.body;
    const poolId = req.params.id;
    const storeId = req.user.storeId;

    if (status == null || status === "") {
      return sendError(res, 400, "status required");
    }
    if (!SHIFT_POOL_STATUSES.includes(status)) {
      return sendError(res, 400, "invalid status");
    }

    await dbp.beginTransaction();
    try {
      const [locked] = await dbp.execute(
        `SELECT sp.id, sp.shift_id, sp.requested_by, sp.status AS pool_status
         FROM shift_pool sp
         INNER JOIN shifts s ON s.id = sp.shift_id AND s.store_id = ?
         WHERE sp.id = ? FOR UPDATE`,
        [storeId, poolId]
      );
      if (!locked.length) {
        await dbp.rollback();
        return sendError(res, 404, "pool entry not found or not in your store");
      }

      const row = locked[0];
      const poolSt = String(row.pool_status || "");

      if (status === "approved") {
        if (poolSt !== "claimed" || !row.requested_by) {
          await dbp.rollback();
          return sendError(res, 400, "invalid state for pool approval");
        }
        const assignee = Number(row.requested_by);
        const [shiftUpd] = await dbp.execute(
          "UPDATE shifts SET employee_id = ? WHERE id = ? AND store_id = ?",
          [assignee, row.shift_id, storeId]
        );
        if (!shiftUpd.affectedRows) {
          await dbp.rollback();
          return sendError(res, 500, "could not assign shift");
        }
        await dbp.execute(
          `DELETE sr FROM swap_requests sr
           INNER JOIN shifts s ON s.id = sr.shift_id
           WHERE sr.shift_id = ?
           AND s.store_id = ?
           AND sr.status IN ('pending','awaiting_approval')`,
          [row.shift_id, storeId]
        );
        await dbp.execute(
          `DELETE sp FROM shift_pool sp
           INNER JOIN shifts s ON s.id = sp.shift_id
           WHERE sp.shift_id = ? AND s.store_id = ?`,
          [row.shift_id, storeId]
        );
        await dbp.commit();
        await bumpShiftsRevisionForStore(storeId);
        return sendData(res, { success: true });
      }

      let requested_by = row.requested_by;
      if (status === "claimed") {
        requested_by = req.user.employeeId;
        if (requested_by == null) {
          await dbp.rollback();
          return sendError(res, 400, "Account must be linked to an employee to claim shifts");
        }
        if (poolSt !== "posted") {
          await dbp.rollback();
          return sendError(res, 400, "invalid state for claim");
        }
      } else if (status === "posted") {
        requested_by = null;
        if (poolSt !== "claimed" && poolSt !== "posted") {
          await dbp.rollback();
          return sendError(res, 400, "invalid state for pool update");
        }
      }

      await dbp.execute(
        `UPDATE shift_pool sp
         INNER JOIN shifts s ON s.id = sp.shift_id AND s.store_id = ?
         SET sp.requested_by=?, sp.status=?
         WHERE sp.id=?`,
        [storeId, requested_by, status, poolId]
      );

      await dbp.commit();
      return sendData(res, { success: true });
    } catch (innerErr) {
      await dbp.rollback();
      return sendError(res, 500, innerErr.message);
    }
  });

  r.delete("/shift-pool/:id", auth, requireStore, (req, res) => {
    db.query(
      `DELETE sp FROM shift_pool sp
       INNER JOIN shifts s ON s.id = sp.shift_id AND s.store_id = ?
       WHERE sp.id=?`,
      [req.user.storeId, req.params.id],
      (err, result) => {
        if (err) return sendError(res, 500, err.message);
        if (!result.affectedRows) {
          return sendError(res, 404, "pool entry not found or not in your store");
        }
        return sendData(res, { success: true });
      }
    );
  });

  r.get("/sent-days", auth, requireStore, (req, res) => {
    db.query("SELECT date FROM sent_days WHERE store_id = ?", [req.user.storeId], (err, rows) => {
      if (err) return sendError(res, 500, err.message);

      const dates = rows.map((r) =>
        r.date instanceof Date
          ? r.date.toISOString().slice(0, 10)
          : r.date
      );

      return sendData(res, dates);
    });
  });

  r.post("/sent-days", auth, requireStore, async (req, res) => {
    const { date } = req.body;
    const sent_by = req.user.employeeId ?? null;

    if (!date) return sendError(res, 400, "date required");

    try {
      await dbp.execute(
        "INSERT INTO sent_days (store_id, date, sent_by) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE sent_by=VALUES(sent_by)",
        [req.user.storeId, date, sent_by]
      );
      return sendData(res, { success: true });
    } catch (err) {
      return sendError(res, 500, err.message);
    }
  });

  r.delete("/sent-days/:date", auth, requireStore, (req, res) => {
    db.query("DELETE FROM sent_days WHERE date=? AND store_id=?", [req.params.date, req.user.storeId], (err, result) => {
      if (err) return sendError(res, 500, err.message);
      if (!result.affectedRows) return sendError(res, 404, "sent day not found");
      return sendData(res, { success: true });
    });
  });

  // =========================
  // SWAP REQUESTS
  // =========================

  r.get("/swap-requests", auth, requireStore, async (req, res) => {
    try {
      const [rows] = await dbp.execute(
        `SELECT sr.*
         FROM swap_requests sr
         INNER JOIN shifts s ON s.id = sr.shift_id
         WHERE s.store_id = ?`,
        [req.user.storeId]
      );
      return sendData(res, rows);
    } catch (err) {
      return sendError(res, 500, err.message);
    }
  });

  r.post("/swap-requests", auth, requireStore, async (req, res) => {
    const { shift_id, to_employee_id } = req.body;

    if (!shift_id || !to_employee_id) {
      return sendError(res, 400, "shift_id and to_employee_id required");
    }

    const from_employee_id = req.user.employeeId;
    if (from_employee_id == null) {
      return sendError(res, 400, "Account must be linked to an employee");
    }

    const shiftId = Number(shift_id);
    const toId = Number(to_employee_id);
    if (!Number.isFinite(shiftId) || shiftId <= 0 || !Number.isFinite(toId) || toId <= 0) {
      return sendError(res, 400, "invalid shift_id or to_employee_id");
    }
    if (toId === from_employee_id) {
      return sendError(res, 400, "cannot swap with yourself");
    }

    try {
      const [shiftRows] = await dbp.execute(
        "SELECT id FROM shifts WHERE id = ? AND store_id = ? AND employee_id = ? LIMIT 1",
        [shiftId, req.user.storeId, from_employee_id]
      );
      if (!shiftRows.length) {
        return sendError(res, 404, "shift not found or not assigned to you");
      }

      const [dupSwap] = await dbp.execute(
        `SELECT sr.id
         FROM swap_requests sr
         INNER JOIN shifts s ON s.id = sr.shift_id
         WHERE sr.shift_id = ?
         AND s.store_id = ?
         AND sr.status IN ('pending', 'awaiting_approval')
         LIMIT 1`,
        [shiftId, req.user.storeId]
      );
      if (dupSwap.length) {
        return sendError(res, 409, "an active swap request already exists for this shift");
      }

      const [dupPool] = await dbp.execute(
        `SELECT sp.id FROM shift_pool sp
         INNER JOIN shifts s ON s.id = sp.shift_id AND s.store_id = ?
         WHERE sp.shift_id = ? AND sp.status IN ('posted', 'claimed')
         LIMIT 1`,
        [req.user.storeId, shiftId]
      );
      if (dupPool.length) {
        return sendError(res, 409, "this shift is already listed in the swap pool");
      }

      const [toRows] = await dbp.execute(
        "SELECT id FROM employees WHERE id = ? AND store_id = ? LIMIT 1",
        [toId, req.user.storeId]
      );
      if (!toRows.length) {
        return sendError(res, 400, "target employee not in store");
      }

      const [fromRows] = await dbp.execute(
        "SELECT id FROM employees WHERE id = ? AND store_id = ? LIMIT 1",
        [from_employee_id, req.user.storeId]
      );
      if (!fromRows.length) {
        return sendError(res, 403, "your employee is not in this store");
      }

      const [result] = await dbp.execute(
        `INSERT INTO swap_requests (shift_id, from_employee_id, to_employee_id, status)
         VALUES (?, ?, ?, 'pending')`,
        [shiftId, from_employee_id, toId]
      );
      return sendData(res, { id: result.insertId });
    } catch (err) {
      return sendError(res, 500, err.message);
    }
  });

  r.put("/swap-requests/:id", auth, requireStore, async (req, res) => {
    const { status } = req.body;

    if (!SWAP_REQUEST_PUT_STATUSES.includes(status)) {
      return sendError(res, 400, "invalid status");
    }

    const sid = Number(req.params.id);
    if (!Number.isFinite(sid) || sid <= 0) {
      return sendError(res, 400, "invalid id");
    }

    const role = String(req.user.role || "").toLowerCase();
    const isManager = role === "owner" || role === "manager";
    const empId = req.user.employeeId;
    const storeId = req.user.storeId;

    try {
      if (status === "approved") {
        if (!isManager) {
          return sendError(res, 403, "only managers can approve");
        }

        await dbp.beginTransaction();
        try {
          const [locked] = await dbp.execute(
            `SELECT sr.id, sr.shift_id, sr.from_employee_id, sr.to_employee_id, sr.status AS sr_status
             FROM swap_requests sr
             INNER JOIN shifts s ON s.id = sr.shift_id AND s.store_id = ?
             WHERE sr.id = ? FOR UPDATE`,
            [storeId, sid]
          );
          if (!locked.length || String(locked[0].sr_status) !== "awaiting_approval") {
            await dbp.rollback();
            return sendError(res, 400, "swap request not found or invalid state for approval");
          }

          const swap = locked[0];

          const [shiftUpd] = await dbp.execute(
            "UPDATE shifts SET employee_id = ? WHERE id = ? AND store_id = ?",
            [swap.to_employee_id, swap.shift_id, storeId]
          );
          if (!shiftUpd.affectedRows) {
            await dbp.rollback();
            return sendError(res, 500, "could not update shift");
          }

          await dbp.execute("UPDATE swap_requests SET status = 'approved' WHERE id = ?", [sid]);

          await dbp.execute(
            `DELETE sr FROM swap_requests sr
             INNER JOIN shifts s ON s.id = sr.shift_id
             WHERE sr.shift_id = ?
             AND s.store_id = ?
             AND sr.status IN ('pending','awaiting_approval')`,
            [swap.shift_id, storeId]
          );

          await dbp.execute(
            `DELETE sp FROM shift_pool sp
             INNER JOIN shifts s ON s.id = sp.shift_id
             WHERE sp.shift_id = ? AND s.store_id = ?`,
            [swap.shift_id, storeId]
          );

          await dbp.commit();
          await bumpShiftsRevisionForStore(storeId);
          return sendData(res, { success: true });
        } catch (inner) {
          await dbp.rollback();
          return sendError(res, 500, inner.message);
        }
      }

      await dbp.beginTransaction();
      try {
        const [rows] = await dbp.execute(
          `SELECT sr.id, sr.shift_id, sr.from_employee_id, sr.to_employee_id, sr.status AS sr_status
           FROM swap_requests sr
           INNER JOIN shifts s ON s.id = sr.shift_id AND s.store_id = ?
           WHERE sr.id = ? FOR UPDATE`,
          [storeId, sid]
        );
        if (!rows.length) {
          await dbp.rollback();
          return sendError(res, 404, "swap request not found");
        }

        const swap = rows[0];
        const cur = String(swap.sr_status || "");

        if (status === "awaiting_approval") {
          if (cur !== "pending") {
            await dbp.rollback();
            return sendError(res, 400, "invalid state for accept");
          }
          if (empId == null || Number(swap.to_employee_id) !== empId) {
            await dbp.rollback();
            return sendError(res, 403, "only the recipient can accept");
          }
          await dbp.execute("UPDATE swap_requests SET status = ? WHERE id = ?", [status, sid]);
          await dbp.commit();
          return sendData(res, { success: true });
        }

        if (status === "rejected") {
          if (cur === "pending") {
            if (empId == null || Number(swap.to_employee_id) !== empId) {
              await dbp.rollback();
              return sendError(res, 403, "only the recipient can reject");
            }
          } else if (cur === "awaiting_approval") {
            if (!isManager) {
              await dbp.rollback();
              return sendError(res, 403, "only managers can reject at this stage");
            }
          } else {
            await dbp.rollback();
            return sendError(res, 400, "request already finalized or invalid state");
          }
          await dbp.execute("UPDATE swap_requests SET status = 'rejected' WHERE id = ?", [sid]);
          await dbp.commit();
          return sendData(res, { success: true });
        }

        await dbp.rollback();
        return sendError(res, 400, "unexpected status");
      } catch (inner2) {
        await dbp.rollback();
        return sendError(res, 500, inner2.message);
      }
    } catch (err) {
      return sendError(res, 500, err.message);
    }
  });
}

async function auth(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) {
    return sendError(res, 401, "No token");
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const userId = Number(decoded.userId ?? decoded.id);
    if (!Number.isFinite(userId) || userId <= 0) {
      return sendError(res, 401, "Invalid token payload");
    }
    const storeId = Number(req.headers["x-store-id"]);

    if (!Number.isFinite(storeId) || storeId <= 0) {
      return sendError(res, 400, "store_id required");
    }

    const [rows] = await dbp.execute(
      `SELECT 
         sm.store_id,
         sm.role,
         e.id AS employee_id
       FROM store_members sm
       LEFT JOIN employees e
         ON e.user_id = sm.user_id 
         AND e.store_id = sm.store_id
       WHERE sm.user_id = ? AND sm.store_id = ?
       LIMIT 1`,
      [userId, storeId]
    );

    if (!rows.length) {
      return sendError(res, 403, "not a member of this store");
    }

    req.user = {
      id: userId,
      storeId,
      role: rows[0].role,
      employeeId: rows[0].employee_id || null,
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

async function bumpShiftsRevisionForStore(storeId) {
  await dbp.execute("UPDATE stores SET shifts_revision = shifts_revision + 1 WHERE id = ?", [storeId]);
}

/** @returns {string|null} error message or null if ok */
function assertShiftEndAfterStart(start_time, end_time) {
  const s = new Date(start_time).getTime();
  const e = new Date(end_time).getTime();
  if (!Number.isFinite(s) || !Number.isFinite(e)) {
    return "invalid shift times";
  }
  if (e <= s) {
    return "end_time must be after start_time";
  }
  return null;
}

/** @returns {string|null} error message or null if ok */
function assertNoEmployeeShiftOverlaps(normalized) {
  for (const r of normalized) {
    const te = assertShiftEndAfterStart(r.start_time, r.end_time);
    if (te) return te;
  }
  const intervals = normalized.map((r) => {
    const start = new Date(r.start_time).getTime();
    const end = new Date(r.end_time).getTime();
    return { eid: r.employee_id, start, end };
  });
  for (let i = 0; i < intervals.length; i++) {
    for (let j = i + 1; j < intervals.length; j++) {
      if (intervals[i].eid !== intervals[j].eid) continue;
      if (intervals[i].start < intervals[j].end && intervals[j].start < intervals[i].end) {
        return "overlapping shifts for the same employee";
      }
    }
  }
  return null;
}

const PORT = process.env.PORT || 3000;
let httpServerStarted = false;
function startHttpServer() {
  if (httpServerStarted) return;
  httpServerStarted = true;
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

async function runStartupMigrations() {
  async function tryAlter(sql) {
    try {
      await dbp.query(sql);
    } catch (e) {
      if (e.errno === 1060 || e.errno === 1061 || e.errno === 1826) return;
      if (e.errno === 1062) {
        console.warn("Migration skipped (duplicate values):", sql.slice(0, 80), e.message);
        return;
      }
      console.error("Migration failed:", sql.slice(0, 100), e.message);
    }
  }

  await tryAlter("ALTER TABLE employees ADD COLUMN user_id INT NULL");
  await tryAlter("ALTER TABLE employees MODIFY COLUMN user_id INT NULL");
  try {
    await dbp.query("ALTER TABLE stores DROP INDEX uq_stores_name");
  } catch (e) {
    if (e.errno !== 1091) {
      console.warn("Could not drop stores.uq_stores_name (if absent):", e.message);
    }
  }
}

db.connect((err) => {
  if (err) {
    console.error("DB connection failed:", err);
    startHttpServer();
    return;
  }
  console.log("Connected to MySQL");
  db.query(
    `CREATE TABLE IF NOT EXISTS stores (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      shifts_revision INT UNSIGNED NOT NULL DEFAULT 0
    )`,
    (storesErr) => {
      if (storesErr) console.error("Could not ensure stores table:", storesErr);
    }
  );
  db.query(
    "ALTER TABLE stores ADD COLUMN shifts_revision INT UNSIGNED NOT NULL DEFAULT 0",
    (alterErr) => {
      if (alterErr && alterErr.errno !== 1060) {
        console.error("Could not ensure stores.shifts_revision:", alterErr);
      }
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
  runStartupMigrations()
    .then(() => startHttpServer())
    .catch((migrationErr) => {
      console.error("Startup migrations:", migrationErr);
      startHttpServer();
    });
});

// =========================
// AUTH
// =========================
async function loginHandler(req, res) {
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");
  const storeName = String(req.body?.storeName || "").trim();

  if (!username || !password || !storeName) {
    return sendError(res, 400, "username, password, and storeName required");
  }

  try {
    const [users] = await dbp.execute(
      "SELECT * FROM users WHERE username = ? LIMIT 1",
      [username]
    );

    if (!users.length) return sendError(res, 401, "invalid credentials");

    const user = users[0];
    const storedPassword = String(user.password || "");
    let passwordOk = false;
    if (storedPassword.startsWith("$2")) {
      passwordOk = await bcrypt.compare(password, storedPassword);
    } else {
      passwordOk = storedPassword === password;
      if (passwordOk) {
        const upgradedHash = await bcrypt.hash(password, 10);
        await dbp.execute("UPDATE users SET password=? WHERE id=?", [upgradedHash, user.id]);
      }
    }
    if (!passwordOk) {
      return sendError(res, 401, "invalid credentials");
    }

    const [rows] = await dbp.execute(
      `SELECT 
         s.id AS store_id,
         sm.role,
         e.id AS employee_id
       FROM stores s
       JOIN store_members sm 
         ON sm.store_id = s.id
       LEFT JOIN employees e 
         ON e.user_id = sm.user_id 
         AND e.store_id = sm.store_id
       WHERE sm.user_id = ? AND s.name = ?
       LIMIT 1`,
      [user.id, storeName]
    );

    if (!rows.length) {
      return sendError(res, 403, "not a member of that store");
    }

    const row = rows[0];

    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: "7d" });

    return sendData(res, {
      token,
      storeId: row.store_id,
      role: row.role,
      employeeId: row.employee_id,
    });
  } catch (err) {
    return sendError(res, 500, "login failed");
  }
}

async function createStoreHandler(req, res) {
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");
  const storeName = String(req.body?.storeName || "").trim();

  if (!username || !password || !storeName) {
    return sendError(res, 400, "username, password, and storeName are required");
  }

  try {
    await dbp.beginTransaction();

    const hashedPassword = await bcrypt.hash(password, 10);

    const [userResult] = await dbp.query(
      "INSERT INTO users (username, password) VALUES (?, ?)",
      [username, hashedPassword]
    );

    const userId = userResult.insertId;

    const [storeResult] = await dbp.query(
      "INSERT INTO stores (name) VALUES (?)",
      [storeName]
    );

    const storeId = storeResult.insertId;

    await dbp.query(
      "INSERT INTO store_members (user_id, store_id, role) VALUES (?, ?, 'owner')",
      [userId, storeId]
    );

    const [empInsert] = await dbp.execute(
      "INSERT INTO employees (user_id, store_id, name, role, availability) VALUES (?, ?, ?, 'owner', ?)",
      [userId, storeId, username, JSON.stringify({})]
    );

    await dbp.commit();

    const token = jwt.sign({ id: userId }, JWT_SECRET, { expiresIn: "7d" });

    return sendData(res, {
      success: true,
      userId,
      storeId,
      token,
      employeeId: empInsert.insertId,
    });
  } catch (err) {
    await dbp.rollback();
    console.error("CREATE STORE ERROR:", err);
    return sendError(res, 500, err.message);
  }
}

// =========================
// API v1 (mounted router)
// =========================
v1Router.post("/auth/login", authLimiter, loginHandler);
v1Router.post("/auth/register", authLimiter, createStoreHandler);
v1Router.get("/health", (req, res) => sendData(res, { status: "ok" }));

const meV1 = express.Router();
meV1.use(auth);
registerMeSubroutes(meV1);
v1Router.use("/me", meV1);

registerResourceRoutes(v1Router);

app.use("/api/v1", v1Router);

// =========================
// Legacy (non-versioned) aliases
// =========================
app.post("/login", authLimiter, loginHandler);
app.post("/create-store", authLimiter, createStoreHandler);
app.post("/auth/login", authLimiter, loginHandler);
app.post("/auth/register", authLimiter, createStoreHandler);
app.get("/health", (req, res) => sendData(res, { status: "ok" }));

const meLegacy = express.Router();
meLegacy.use(auth);
registerMeSubroutes(meLegacy);
app.use("/me", meLegacy);

// Resource routes live only under /api/v1 (see registerResourceRoutes(v1Router) above).

// =========================
// SERVER (listen starts from db.connect after schema checks)
// =========================