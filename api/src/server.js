import { createApp } from "./app.js";
import { hashPassword } from "./auth.js";
import { pool } from "./database.js";

const port = Number(process.env.API_PORT ?? 3000);
const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
const adminPassword = process.env.ADMIN_PASSWORD;

try {
  if (!adminEmail || !adminPassword || adminPassword.length < 5 || adminPassword.length > 128) {
    throw new Error("Set ADMIN_EMAIL and an ADMIN_PASSWORD of 8 to 128 characters.");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail) || adminEmail.length > 254) {
    throw new Error("ADMIN_EMAIL must be a valid email address.");
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(254) NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role VARCHAR(16) NOT NULL CHECK (role IN ('admin', 'user')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash CHAR(64) PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id SERIAL PRIMARY KEY,
      title VARCHAR(200) NOT NULL,
      completed BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  await pool.query("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE");
  await pool.query("CREATE INDEX IF NOT EXISTS tasks_user_id_id_idx ON tasks(user_id, id DESC)");

  const passwordHash = await hashPassword(adminPassword);
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, role)
     VALUES ($1, $2, 'admin')
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'admin'
     RETURNING id`,
    [adminEmail, passwordHash]
  );
  await pool.query("UPDATE tasks SET user_id = $1 WHERE user_id IS NULL", [rows[0].id]);
} catch (error) {
  console.error("Could not initialize the database.", error);
  process.exit(1);
}

const server = createApp(pool).listen(port, () => {
  console.log(`API listening on http://localhost:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
  });
}
