# Pipeline Playground

A small React + Node.js + PostgreSQL task app for exercising a CI pipeline. The project is a clean starting point; adapt it locally for your own pipeline experiments.

## Requirements

- Node.js 22 or newer
- Docker Compose

## Run locally

1. Copy `.env.example` to `.env` and set a private `ADMIN_PASSWORD` (8–128 characters).
2. Start PostgreSQL: `docker compose up -d db`
3. Install dependencies: `npm install`
4. Start the API in one terminal: `npm run dev:api`
5. Start the frontend in another terminal: `npm run dev:web`
6. Open the Vite URL shown in the frontend terminal (normally `http://localhost:5173`).

The API creates the required tables and bootstraps the administrator from `ADMIN_EMAIL` and
`ADMIN_PASSWORD` at startup. Keep these credentials private. Users can register as regular
users; the role is never accepted from registration input. Sessions are stored server-side
and exposed to the browser only through an HTTP-only cookie.

Regular users can create and manage only their own tasks; their board URL is `/users/<id>`.
Administrators can view and manage all tasks, and can open a client's board from the client
list. Board access is checked by the API, so changing a URL cannot grant a regular user access
to another user's tasks. Existing tasks are assigned to the configured administrator during startup.
The frontend proxies `/api` requests to `http://localhost:3000`.

## Validate

- `npm test` runs the API tests.
- `npm run build` builds the React frontend.

The GitHub Actions workflow runs install, tests, and frontend build on pushes and pull requests.
