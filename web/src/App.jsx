import { useCallback, useEffect, useState } from "react";

async function request(path, options) {
  const response = await fetch(path, options);
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error ?? `Request failed (${response.status})`);
  }
  return response.status === 204 ? null : response.json();
}

function boardIdFromPath() {
  const match = window.location.pathname.match(/^\/users\/([1-9]\d*)$/);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) ? id : null;
}

export default function App() {
  const [user, setUser] = useState(null);
  const [boardUserId, setBoardUserId] = useState(null);
  const [clients, setClients] = useState([]);
  const [authLoading, setAuthLoading] = useState(true);
  const [authMode, setAuthMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [tasks, setTasks] = useState([]);
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const loadTasks = useCallback(async (userId) => {
    setLoading(true);
    setTasks([]);
    setError("");
    try {
      setTasks(
        await request(`/api/tasks?userId=${encodeURIComponent(userId)}`),
      );
      setError("");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    async function loadSession() {
      try {
        const result = await request("/api/auth/me");
        setUser(result.user);
        if (result.user) {
          const requestedBoardId = boardIdFromPath();
          const targetId =
            result.user.role === "admin" && requestedBoardId
              ? requestedBoardId
              : result.user.id;
          if (
            result.user.role !== "admin" &&
            requestedBoardId &&
            requestedBoardId !== result.user.id
          ) {
            window.history.replaceState({}, "", `/users/${result.user.id}`);
          } else if (!requestedBoardId) {
            window.history.replaceState({}, "", `/users/${result.user.id}`);
          }
          setBoardUserId(targetId);
          if (result.user.role === "admin")
            setClients(await request("/api/users"));
          await loadTasks(targetId);
        }
      } catch (err) {
        setError(err.message);
      } finally {
        setAuthLoading(false);
      }
    }

    loadSession();
  }, [loadTasks]);

  useEffect(() => {
    if (!user) return undefined;
    function handlePopState() {
      const requestedBoardId = boardIdFromPath();
      const targetId =
        user.role === "admin" && requestedBoardId ? requestedBoardId : user.id;
      if (
        user.role !== "admin" &&
        requestedBoardId &&
        requestedBoardId !== user.id
      ) {
        window.history.replaceState({}, "", `/users/${user.id}`);
      }
      if (!requestedBoardId && user.role === "admin") {
        window.history.replaceState({}, "", `/users/${user.id}`);
      }
      setBoardUserId(targetId);
      loadTasks(targetId);
    }

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [user, loadTasks]);

  async function selectBoard(id) {
    window.history.pushState({}, "", `/users/${id}`);
    setBoardUserId(id);
    await loadTasks(id);
  }

  async function submitAuth(event) {
    event.preventDefault();
    setAuthSubmitting(true);
    try {
      const result = await request(
        `/api/auth/${authMode === "login" ? "login" : "register"}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, password }),
        },
      );
      setUser(result.user);
      setBoardUserId(result.user.id);
      window.history.replaceState({}, "", `/users/${result.user.id}`);
      if (result.user.role === "admin") setClients(await request("/api/users"));
      setPassword("");
      setError("");
      await loadTasks(result.user.id);
    } catch (err) {
      setError(err.message);
    } finally {
      setAuthSubmitting(false);
    }
  }

  async function logout() {
    try {
      await request("/api/auth/logout", { method: "POST" });
      setUser(null);
      setBoardUserId(null);
      setClients([]);
      setTasks([]);
      window.history.replaceState({}, "", "/");
      setError("");
    } catch (err) {
      setError(err.message);
    }
  }

  async function addTask(event) {
    event.preventDefault();
    if (!title.trim()) return;
    try {
      const task = await request("/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title }),
      });
      setTasks((current) => [task, ...current]);
      setTitle("");
      setError("");
    } catch (err) {
      setError(err.message);
    }
  }

  async function toggleTask(task) {
    try {
      const updated = await request(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ completed: !task.completed }),
      });
      setTasks((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
      setError("");
    } catch (err) {
      setError(err.message);
    }
  }

  async function removeTask(id) {
    try {
      await request(`/api/tasks/${id}`, { method: "DELETE" });
      setTasks((current) => current.filter((task) => task.id !== id));
      setError("");
    } catch (err) {
      setError(err.message);
    }
  }

  const completedCount = tasks.filter((task) => task.completed).length;

  return (
    <main className="shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Pipeline Playground home">
          <span className="brand-mark">P</span>
          <span>pipeline playground</span>
        </a>
        {user ? (
          <div className="account">
            <span className="role-badge">
              {user.role === "admin" ? "Администратор" : "Пользователь"}
            </span>
            <span className="account-email">{user.email}</span>
            <button type="button" className="logout-button" onClick={logout}>
              Выйти
            </button>
          </div>
        ) : (
          <span className="environment">
            <span /> local environment
          </span>
        )}
      </header>

      <section className="content">
        {authLoading ? (
          <p className="empty-state">Проверяем сессию…</p>
        ) : !user ? (
          <section
            className="auth-card"
            aria-label={authMode === "login" ? "Вход" : "Регистрация"}
          >
            <p className="eyebrow">PIPELINE PLAYGROUND</p>
            <h1>
              {authMode === "login" ? "С возвращением." : "Создать аккаунт."}
            </h1>
            <p className="intro">
              {authMode === "login"
                ? "Войдите, чтобы открыть свои задачи."
                : "Зарегистрируйтесь, чтобы начать работу."}
            </p>
            <form className="auth-form" onSubmit={submitAuth}>
              <label htmlFor="auth-email">Электронная почта</label>
              <input
                id="auth-email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                maxLength={254}
                required
              />
              <label htmlFor="auth-password">Пароль</label>
              <input
                id="auth-password"
                type="password"
                autoComplete={
                  authMode === "login" ? "current-password" : "new-password"
                }
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                minLength={5}
                maxLength={128}
                required
              />
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
              <button type="submit" disabled={authSubmitting}>
                {authSubmitting
                  ? "Подождите…"
                  : authMode === "login"
                    ? "Войти"
                    : "Зарегистрироваться"}
              </button>
            </form>
            <button
              className="auth-switch"
              type="button"
              onClick={() => {
                setAuthMode(authMode === "login" ? "register" : "login");
                setError("");
              }}
            >
              {authMode === "login"
                ? "Нет аккаунта? Зарегистрироваться"
                : "Уже есть аккаунт? Войти"}
            </button>
          </section>
        ) : (
          <>
            {user.role === "admin" && (
              <nav
                className="board-navigation"
                aria-label="Доски пользователей"
              >
                <button
                  type="button"
                  className={
                    boardUserId === user.id
                      ? "board-link selected"
                      : "board-link"
                  }
                  onClick={() => selectBoard(user.id)}
                >
                  Моя доска <span>#{user.id}</span>
                </button>
                <div className="client-tabs">
                  <strong>Клиенты</strong>
                  {clients.map((client) => (
                    <button
                      type="button"
                      key={client.id}
                      className={
                        boardUserId === client.id
                          ? "board-link selected"
                          : "board-link"
                      }
                      onClick={() => selectBoard(client.id)}
                    >
                      #{client.id} <span>{client.email}</span>
                    </button>
                  ))}
                  {clients.length === 0 && (
                    <span className="no-clients">
                      Пока нет зарегистрированных клиентов
                    </span>
                  )}
                </div>
              </nav>
            )}
            <p className="eyebrow">YOUR WORKSPACE</p>
            <h1>
              {user.role === "admin" && boardUserId !== user.id ? (
                <>
                  Client #{boardUserId}
                  <br />
                  <span>task board.</span>
                </>
              ) : (
                <>
                  Small steps,
                  <br />
                  <span>real progress.</span>
                </>
              )}
            </h1>
            <p className="intro">
              {user.role === "admin" && boardUserId !== user.id
                ? `Tasks for ${clients.find((client) => client.id === boardUserId)?.email ?? `user #${boardUserId}`}.`
                : user.role === "admin"
                  ? `Your administrator board · #${user.id}`
                  : `Your personal board · #${user.id}`}
            </p>

            {boardUserId === user.id && (
              <form className="task-form" onSubmit={addTask}>
                <label className="visually-hidden" htmlFor="task-title">
                  New task
                </label>
                <input
                  id="task-title"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="What needs to get done?"
                  maxLength={200}
                />
                <button type="submit" disabled={!title.trim()}>
                  Add task <span aria-hidden="true">+</span>
                </button>
              </form>
            )}

            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}

            <section className="task-card" aria-label="Task list">
              <div className="list-heading">
                <h2>Tasks</h2>
                <span>
                  {completedCount} of {tasks.length} done
                </span>
              </div>
              {loading ? (
                <p className="empty-state">Loading your tasks…</p>
              ) : tasks.length === 0 ? (
                <div className="empty-state">
                  <span className="empty-icon" aria-hidden="true">
                    ✳
                  </span>
                  <strong>Your list is clear.</strong>
                  <span>Add a task to get started.</span>
                </div>
              ) : (
                <ul className="task-list">
                  {tasks.map((task) => (
                    <li
                      className={task.completed ? "task completed" : "task"}
                      key={task.id}
                    >
                      <label>
                        <input
                          type="checkbox"
                          checked={task.completed}
                          onChange={() => toggleTask(task)}
                        />
                        <span className="checkmark" aria-hidden="true" />
                        <span
                          className="task-title"
                          dangerouslySetInnerHTML={{ __html: task.title }}
                        />
                      </label>
                      <button
                        className="remove-button"
                        type="button"
                        aria-label={`Delete ${task.title}`}
                        onClick={() => removeTask(task.id)}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <p className="footer-note">
              Built for focused work. One task at a time.
            </p>
          </>
        )}
      </section>
    </main>
  );
}
