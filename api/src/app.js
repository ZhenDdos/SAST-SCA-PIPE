import express from "express";
import {
  createSessionToken,
  hashPassword,
  hashSessionToken,
  verifyPassword
} from "./auth.js";

const SESSION_COOKIE = "pipeline_session";
const SESSION_DURATION_SECONDS = 7 * 24 * 60 * 60;

function sessionCookie(token, secure) {
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DURATION_SECONDS}${secure ? "; Secure" : ""}`;
}

function readSessionToken(request) {
  const cookie = request.headers.cookie?.split(";").find((part) => part.trim().startsWith(`${SESSION_COOKIE}=`));
  return cookie?.trim().slice(SESSION_COOKIE.length + 1);
}

function validEmail(value) {
  return typeof value === "string" &&
    value.trim().length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function validPassword(value) {
  return typeof value === "string" && value.length >= 8 && value.length <= 128;
}

export function createApp(pool) {
  const app = express();
  const secureCookie = process.env.NODE_ENV === "production";

  app.disable("x-powered-by");
  app.use(express.json({ limit: "16kb" }));

  app.get("/api/health", async (_request, response, next) => {
    try {
      await pool.query("SELECT 1");
      response.json({ status: "ok" });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/auth/register", async (request, response, next) => {
    const { email, password } = request.body ?? {};
    if (!validEmail(email) || !validPassword(password)) {
      response.status(400).json({ error: "Enter a valid email and a password of 8 to 128 characters." });
      return;
    }

    try {
      const passwordHash = await hashPassword(password);
      const { rows } = await pool.query(
        "INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'user') RETURNING id, email, role",
        [email.trim().toLowerCase(), passwordHash]
      );
      const user = rows[0];
      const token = createSessionToken();
      await pool.query(
        "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL '7 days')",
        [hashSessionToken(token), user.id]
      );
      response.setHeader("Set-Cookie", sessionCookie(token, secureCookie));
      response.status(201).json({ user });
    } catch (error) {
      if (error.code === "23505") {
        response.status(409).json({ error: "An account with this email already exists." });
        return;
      }
      next(error);
    }
  });

  app.post("/api/auth/login", async (request, response, next) => {
    const { email, password } = request.body ?? {};
    if (!validEmail(email) || typeof password !== "string" || password.length < 1 || password.length > 128) {
      response.status(400).json({ error: "Enter a valid email and password." });
      return;
    }

    try {
      const { rows } = await pool.query(
        "SELECT id, email, role, password_hash FROM users WHERE email = $1",
        [email.trim().toLowerCase()]
      );
      const account = rows[0];
      if (!account || !(await verifyPassword(password, account.password_hash))) {
        response.status(401).json({ error: "Email or password is incorrect." });
        return;
      }

      const token = createSessionToken();
      await pool.query(
        "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL '7 days')",
        [hashSessionToken(token), account.id]
      );
      response.setHeader("Set-Cookie", sessionCookie(token, secureCookie));
      response.json({ user: { id: account.id, email: account.email, role: account.role } });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/auth/me", async (request, response, next) => {
    const token = readSessionToken(request);
    if (!token) {
      response.json({ user: null });
      return;
    }

    try {
      const { rows } = await pool.query(
        `SELECT users.id, users.email, users.role
         FROM sessions JOIN users ON users.id = sessions.user_id
         WHERE sessions.token_hash = $1 AND sessions.expires_at > NOW()`,
        [hashSessionToken(token)]
      );
      response.json({ user: rows[0] ?? null });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/auth/logout", async (request, response, next) => {
    const token = readSessionToken(request);
    try {
      if (token) {
        await pool.query("DELETE FROM sessions WHERE token_hash = $1", [hashSessionToken(token)]);
      }
      response.setHeader(
        "Set-Cookie",
        `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secureCookie ? "; Secure" : ""}`
      );
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  const requireAuth = async (request, response, next) => {
    const token = readSessionToken(request);
    if (!token) {
      response.status(401).json({ error: "Authentication required." });
      return;
    }

    try {
      const { rows } = await pool.query(
        `SELECT users.id, users.email, users.role
         FROM sessions JOIN users ON users.id = sessions.user_id
         WHERE sessions.token_hash = $1 AND sessions.expires_at > NOW()`,
        [hashSessionToken(token)]
      );
      if (!rows[0]) {
        response.status(401).json({ error: "Authentication required." });
        return;
      }
      request.user = rows[0];
      next();
    } catch (error) {
      next(error);
    }
  };

  app.use("/api/tasks", requireAuth);
  app.use("/api/users", requireAuth);

  app.get("/api/users", async (request, response, next) => {
    if (request.user.role !== "admin") {
      response.status(403).json({ error: "Administrator access required." });
      return;
    }

    try {
      const { rows } = await pool.query(
        "SELECT id, email FROM users WHERE role = 'user' ORDER BY id"
      );
      response.json(rows);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/tasks", async (request, response, next) => {
    const requestedUserId = request.query.userId;
    if (requestedUserId !== undefined && !/^[1-9]\d*$/.test(requestedUserId)) {
      response.status(400).json({ error: "A valid user id is required." });
      return;
    }
    const targetUserId = requestedUserId === undefined
      ? request.user.role === "admin" ? null : request.user.id
      : Number(requestedUserId);
    if (targetUserId !== null && !Number.isSafeInteger(targetUserId)) {
      response.status(400).json({ error: "A valid user id is required." });
      return;
    }
    if (request.user.role !== "admin" && targetUserId !== request.user.id) {
      response.status(403).json({ error: "You can only view your own task board." });
      return;
    }

    try {
      const query = targetUserId === null
        ? "SELECT id, title, completed, created_at FROM tasks ORDER BY id DESC"
        : "SELECT id, title, completed, created_at FROM tasks WHERE user_id = $1 ORDER BY id DESC";
      const { rows } = await pool.query(
        query,
        targetUserId === null ? [] : [targetUserId]
      );
      response.json(rows);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/tasks", async (request, response, next) => {
    const title = request.body?.title;
    if (typeof title !== "string" || title.trim().length === 0 || title.trim().length > 200) {
      response.status(400).json({ error: "Title must be between 1 and 200 characters." });
      return;
    }

    try {
      const { rows } = await pool.query(
        "INSERT INTO tasks (title, user_id) VALUES ($1, $2) RETURNING id, title, completed, created_at",
        [title.trim(), request.user.id]
      );
      response.status(201).json(rows[0]);
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/tasks/:id", async (request, response, next) => {
    const id = Number(request.params.id);
    const { completed } = request.body ?? {};
    if (!Number.isSafeInteger(id) || id < 1 || typeof completed !== "boolean") {
      response.status(400).json({ error: "A valid task id and completed boolean are required." });
      return;
    }

    try {
      const isAdmin = request.user.role === "admin";
      const { rows } = await pool.query(
        `UPDATE tasks SET completed = $1 WHERE id = $2${isAdmin ? "" : " AND user_id = $3"}
         RETURNING id, title, completed, created_at`,
        isAdmin ? [completed, id] : [completed, id, request.user.id]
      );
      if (rows.length === 0) {
        response.status(404).json({ error: "Task not found." });
        return;
      }
      response.json(rows[0]);
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/tasks/:id", async (request, response, next) => {
    const id = Number(request.params.id);
    if (!Number.isSafeInteger(id) || id < 1) {
      response.status(400).json({ error: "A valid task id is required." });
      return;
    }

    try {
      const isAdmin = request.user.role === "admin";
      const result = await pool.query(
        `DELETE FROM tasks WHERE id = $1${isAdmin ? "" : " AND user_id = $2"}`,
        isAdmin ? [id] : [id, request.user.id]
      );
      if (result.rowCount === 0) {
        response.status(404).json({ error: "Task not found." });
        return;
      }
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.use((error, _request, response, _next) => {
    if (error instanceof SyntaxError && "body" in error) {
      response.status(400).json({ error: "Request body must contain valid JSON." });
      return;
    }
    console.error(error);
    response.status(500).json({ error: "Internal server error." });
  });

  return app;
}
