import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createApp } from "../src/app.js";
import { hashPassword, verifyPassword } from "../src/auth.js";

const servers = [];

async function startServer(pool) {
  const server = createApp(pool).listen(0);
  servers.push(server);
  await new Promise((resolve) => server.once("listening", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

function userPool(queryHandler, user = { id: 7, email: "user@example.com", role: "user" }) {
  return {
    query: async (...args) => {
      if (String(args[0]).includes("FROM sessions JOIN users")) return { rows: [user] };
      return queryHandler(...args);
    }
  };
}

const sessionCookie = "pipeline_session=test-session-token";

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve)))
  );
});

test("health endpoint checks the database", async () => {
  const pool = { query: async () => ({ rows: [{ "?column?": 1 }] }) };
  const baseUrl = await startServer(pool);

  const response = await fetch(`${baseUrl}/api/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
});

test("creating a task uses a parameterized query and trims its title", async () => {
  let query;
  const pool = userPool(async (...args) => {
    query = args;
    return {
      rows: [{ id: 1, title: "Test task", completed: false, created_at: "2026-01-01" }]
    };
  });
  const baseUrl = await startServer(pool);

  const response = await fetch(`${baseUrl}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: sessionCookie },
    body: JSON.stringify({ title: "  Test task  " })
  });

  assert.equal(response.status, 201);
  assert.equal(query[1][0], "Test task");
  assert.match(query[0], /VALUES \(\$1, \$2\)/);
  assert.deepEqual(query[1], ["Test task", 7]);
});

test("creating a task rejects an empty title", async () => {
  const pool = userPool(async () => assert.fail("Task query should not run"));
  const baseUrl = await startServer(pool);

  const response = await fetch(`${baseUrl}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: sessionCookie },
    body: JSON.stringify({ title: "   " })
  });

  assert.equal(response.status, 400);
});

test("task endpoints require an authenticated session", async () => {
  const pool = { query: async () => assert.fail("Database should not be queried") };
  const baseUrl = await startServer(pool);

  const response = await fetch(`${baseUrl}/api/tasks`);
  assert.equal(response.status, 401);
});

test("users can only list and update their own tasks", async () => {
  const calls = [];
  const pool = userPool(async (...args) => {
    calls.push(args);
    if (String(args[0]).includes("SELECT id, title")) return { rows: [] };
    return { rows: [] };
  });
  const baseUrl = await startServer(pool);

  const listResponse = await fetch(`${baseUrl}/api/tasks`, {
    headers: { cookie: sessionCookie }
  });
  const updateResponse = await fetch(`${baseUrl}/api/tasks/99`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: sessionCookie },
    body: JSON.stringify({ completed: true })
  });

  assert.equal(listResponse.status, 200);
  assert.match(calls[0][0], /WHERE user_id = \$1/);
  assert.deepEqual(calls[0][1], [7]);
  assert.equal(updateResponse.status, 404);
  assert.match(calls[1][0], /AND user_id = \$3/);
  assert.deepEqual(calls[1][1], [true, 99, 7]);
});

test("users cannot request another user's board", async () => {
  const pool = userPool(async () => assert.fail("A forbidden board query must not reach the database"));
  const baseUrl = await startServer(pool);

  const response = await fetch(`${baseUrl}/api/tasks?userId=8`, {
    headers: { cookie: sessionCookie }
  });

  assert.equal(response.status, 403);
});

test("administrators can list and update tasks without owner restrictions", async () => {
  const calls = [];
  const pool = userPool(
    async (...args) => {
      calls.push(args);
      if (String(args[0]).startsWith("UPDATE")) {
        return { rows: [{ id: 12, title: "Any task", completed: true }] };
      }
      return { rows: [] };
    },
    { id: 1, email: "admin@example.com", role: "admin" }
  );
  const baseUrl = await startServer(pool);

  const listResponse = await fetch(`${baseUrl}/api/tasks`, {
    headers: { cookie: sessionCookie }
  });
  const updateResponse = await fetch(`${baseUrl}/api/tasks/12`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: sessionCookie },
    body: JSON.stringify({ completed: true })
  });

  assert.equal(listResponse.status, 200);
  assert.doesNotMatch(calls[0][0], /WHERE user_id/);
  assert.deepEqual(calls[0][1], []);
  assert.equal(updateResponse.status, 200);
  assert.doesNotMatch(calls[1][0], /AND user_id/);
  assert.deepEqual(calls[1][1], [true, 12]);
});

test("administrators can request a specific user's board", async () => {
  let taskQuery;
  const pool = userPool(
    async (...args) => {
      taskQuery = args;
      return { rows: [] };
    },
    { id: 1, email: "admin@example.com", role: "admin" }
  );
  const baseUrl = await startServer(pool);

  const response = await fetch(`${baseUrl}/api/tasks?userId=8`, {
    headers: { cookie: sessionCookie }
  });

  assert.equal(response.status, 200);
  assert.match(taskQuery[0], /WHERE user_id = \$1/);
  assert.deepEqual(taskQuery[1], [8]);
});

test("only administrators can list client ids", async () => {
  const baseUrl = await startServer(userPool(async () => assert.fail("Regular users must not query clients")));

  const response = await fetch(`${baseUrl}/api/users`, {
    headers: { cookie: sessionCookie }
  });

  assert.equal(response.status, 403);
});

test("administrator client list contains user ids and emails", async () => {
  const pool = userPool(
    async (query) => {
      assert.match(query, /SELECT id, email FROM users WHERE role = 'user'/);
      return { rows: [{ id: 8, email: "client@example.com" }] };
    },
    { id: 1, email: "admin@example.com", role: "admin" }
  );
  const baseUrl = await startServer(pool);

  const response = await fetch(`${baseUrl}/api/users`, {
    headers: { cookie: sessionCookie }
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), [{ id: 8, email: "client@example.com" }]);
});

test("registration assigns the user role and stores a password hash", async () => {
  let inserted;
  const pool = {
    query: async (...args) => {
      if (String(args[0]).startsWith("INSERT INTO users")) {
        inserted = args;
        return { rows: [{ id: 4, email: "new@example.com", role: "user" }] };
      }
      if (String(args[0]).startsWith("INSERT INTO sessions")) return { rows: [] };
      assert.fail(`Unexpected query: ${args[0]}`);
    }
  };
  const baseUrl = await startServer(pool);

  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: " New@Example.com ", password: "correct-horse", role: "admin" })
  });

  assert.equal(response.status, 201);
  assert.match(inserted[0], /'user'/);
  assert.equal(inserted[1][0], "new@example.com");
  assert.notEqual(inserted[1][1], "correct-horse");
  assert.match(response.headers.get("set-cookie"), /HttpOnly/);
  assert.equal((await response.json()).user.role, "user");
});

test("login issues an HTTP-only session after verifying the password", async () => {
  const passwordHash = await hashPassword("correct-horse");
  const pool = {
    query: async (...args) => {
      if (String(args[0]).startsWith("SELECT id, email, role, password_hash")) {
        assert.deepEqual(args[1], ["admin@example.com"]);
        return {
          rows: [{
            id: 1,
            email: "admin@example.com",
            role: "admin",
            password_hash: passwordHash
          }]
        };
      }
      if (String(args[0]).startsWith("INSERT INTO sessions")) return { rows: [] };
      assert.fail(`Unexpected query: ${args[0]}`);
    }
  };
  const baseUrl = await startServer(pool);

  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "ADMIN@example.com", password: "correct-horse" })
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie"), /HttpOnly/);
  assert.equal((await response.json()).user.role, "admin");
});

test("password hashes can be verified without storing the original password", async () => {
  const hash = await hashPassword("correct-horse");
  assert.notEqual(hash, "correct-horse");
  assert.equal(await verifyPassword("correct-horse", hash), true);
  assert.equal(await verifyPassword("incorrect-password", hash), false);
});
