-- CrewPilot canonical schema (run once in MySQL)
CREATE DATABASE IF NOT EXISTS crewpilot;
USE crewpilot;

CREATE TABLE IF NOT EXISTS employees (
  id INT AUTO_INCREMENT PRIMARY KEY,
  store_id INT NULL,
  name VARCHAR(255),
  email VARCHAR(255),
  phone VARCHAR(50),
  role VARCHAR(50),
  availability JSON NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(191) NOT NULL UNIQUE,
  password VARCHAR(255) NOT NULL,
  role VARCHAR(50) NOT NULL,
  employee_id INT NULL,
  CONSTRAINT fk_users_employee
    FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE SET NULL
);

INSERT IGNORE INTO users (username, password, role, employee_id) VALUES
  ('jess', '1212', 'owner', NULL),
  ('donna', '3434', 'owner', NULL);

-- employee_id NULL so ON DELETE SET NULL is valid on employees
CREATE TABLE IF NOT EXISTS shifts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  employee_id INT NULL,
  start DATETIME NOT NULL,
  end DATETIME NOT NULL,
  type VARCHAR(50) NOT NULL,
  CONSTRAINT fk_shifts_employee
    FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS shift_pool (
  id INT AUTO_INCREMENT PRIMARY KEY,
  shift_id INT NOT NULL,
  created_by INT NULL,
  requested_by INT NULL,
  status VARCHAR(50) NOT NULL,
  CONSTRAINT fk_shift_pool_shift
    FOREIGN KEY (shift_id) REFERENCES shifts (id) ON DELETE CASCADE,
  CONSTRAINT fk_shift_pool_created_by
    FOREIGN KEY (created_by) REFERENCES employees (id) ON DELETE SET NULL,
  CONSTRAINT fk_shift_pool_requested_by
    FOREIGN KEY (requested_by) REFERENCES employees (id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS sent_days (
  id INT AUTO_INCREMENT PRIMARY KEY,
  date DATE NOT NULL,
  sent_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_sent_days_sent_by
    FOREIGN KEY (sent_by) REFERENCES employees (id) ON DELETE SET NULL,
  UNIQUE KEY uq_sent_days_date (date)
);

-- Direct swap requests (not in original brief; needed without localStorage)
CREATE TABLE IF NOT EXISTS swap_requests (
  id INT AUTO_INCREMENT PRIMARY KEY,
  shift_id INT NOT NULL,
  from_employee_id INT NULL,
  to_employee_id INT NOT NULL,
  status VARCHAR(64) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_swap_req_shift
    FOREIGN KEY (shift_id) REFERENCES shifts (id) ON DELETE CASCADE,
  CONSTRAINT fk_swap_req_from
    FOREIGN KEY (from_employee_id) REFERENCES employees (id) ON DELETE SET NULL,
  CONSTRAINT fk_swap_req_to
    FOREIGN KEY (to_employee_id) REFERENCES employees (id) ON DELETE CASCADE
);
