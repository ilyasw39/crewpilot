-- CrewPilot canonical schema (run once against a fresh MySQL database).
-- For local reset: DROP DATABASE IF EXISTS crewpilot; then run from the top.
CREATE DATABASE IF NOT EXISTS crewpilot;
USE crewpilot;

-- =========================
-- STORES
-- =========================
CREATE TABLE IF NOT EXISTS stores (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  shifts_revision INT UNSIGNED NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- =========================
-- USERS (auth only; no per-store role here)
-- =========================
CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(255) NOT NULL UNIQUE,
  password VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- =========================
-- STORE MEMBERS
-- =========================
CREATE TABLE IF NOT EXISTS store_members (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  store_id INT NOT NULL,
  role ENUM('owner', 'manager', 'employee') NOT NULL DEFAULT 'employee',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  UNIQUE KEY uq_user_store (user_id, store_id),

  CONSTRAINT fk_store_members_user
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_store_members_store
    FOREIGN KEY (store_id) REFERENCES stores (id) ON DELETE CASCADE
);

-- =========================
-- EMPLOYEES
-- user_id NULL = staff row without a login yet (link later via UPDATE).
-- =========================
CREATE TABLE IF NOT EXISTS employees (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NULL,
  store_id INT NOT NULL,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(100) NULL,
  phone VARCHAR(20) NULL,
  role VARCHAR(50) NOT NULL DEFAULT 'employee',
  availability JSON NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  UNIQUE KEY uq_employees_user_store (user_id, store_id),

  CONSTRAINT fk_employees_user
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_employees_store
    FOREIGN KEY (store_id) REFERENCES stores (id) ON DELETE CASCADE
);

-- =========================
-- SHIFTS
-- =========================
CREATE TABLE IF NOT EXISTS shifts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  store_id INT NOT NULL,
  employee_id INT NULL,
  start_time DATETIME NOT NULL,
  end_time DATETIME NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_shifts_store
    FOREIGN KEY (store_id) REFERENCES stores (id) ON DELETE CASCADE,
  CONSTRAINT fk_shifts_employee
    FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE SET NULL
);

-- =========================
-- SHIFT POOL
-- =========================
CREATE TABLE IF NOT EXISTS shift_pool (
  id INT AUTO_INCREMENT PRIMARY KEY,
  shift_id INT NOT NULL,
  created_by INT NULL,
  requested_by INT NULL,
  status ENUM('posted', 'claimed', 'approved') NOT NULL DEFAULT 'posted',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_shift_pool_shift
    FOREIGN KEY (shift_id) REFERENCES shifts (id) ON DELETE CASCADE,
  CONSTRAINT fk_shift_pool_created_by
    FOREIGN KEY (created_by) REFERENCES employees (id) ON DELETE SET NULL,
  CONSTRAINT fk_shift_pool_requested_by
    FOREIGN KEY (requested_by) REFERENCES employees (id) ON DELETE SET NULL
);

-- =========================
-- SWAP REQUESTS
-- =========================
CREATE TABLE IF NOT EXISTS swap_requests (
  id INT AUTO_INCREMENT PRIMARY KEY,
  shift_id INT NOT NULL,
  from_employee_id INT NULL,
  to_employee_id INT NOT NULL,
  status ENUM('pending', 'awaiting_approval', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_swap_requests_shift
    FOREIGN KEY (shift_id) REFERENCES shifts (id) ON DELETE CASCADE,
  CONSTRAINT fk_swap_requests_from_employee
    FOREIGN KEY (from_employee_id) REFERENCES employees (id) ON DELETE SET NULL,
  CONSTRAINT fk_swap_requests_to_employee
    FOREIGN KEY (to_employee_id) REFERENCES employees (id) ON DELETE CASCADE
);

-- =========================
-- SENT DAYS
-- =========================
CREATE TABLE IF NOT EXISTS sent_days (
  id INT AUTO_INCREMENT PRIMARY KEY,
  store_id INT NOT NULL,
  date DATE NOT NULL,
  sent_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  UNIQUE KEY uq_sent_days_store_date (store_id, date),

  CONSTRAINT fk_sent_days_store
    FOREIGN KEY (store_id) REFERENCES stores (id) ON DELETE CASCADE,
  CONSTRAINT fk_sent_days_sent_by
    FOREIGN KEY (sent_by) REFERENCES employees (id) ON DELETE SET NULL
);

-- =========================
-- INDEXES (IF NOT EXISTS: safe to re-apply on MySQL 8+)
-- =========================
CREATE INDEX IF NOT EXISTS idx_employees_store ON employees (store_id);
CREATE INDEX IF NOT EXISTS idx_employees_user ON employees (user_id);

CREATE INDEX IF NOT EXISTS idx_shifts_store ON shifts (store_id);
CREATE INDEX IF NOT EXISTS idx_shifts_employee ON shifts (employee_id);

CREATE INDEX IF NOT EXISTS idx_shift_pool_shift ON shift_pool (shift_id);

CREATE INDEX IF NOT EXISTS idx_swap_requests_shift ON swap_requests (shift_id);
CREATE INDEX IF NOT EXISTS idx_swap_requests_status ON swap_requests (status);

CREATE INDEX IF NOT EXISTS idx_sent_days_store ON sent_days (store_id);
