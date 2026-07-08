"use strict";

window.TaahudAdmin = (function () {
  const ADMIN_EMAIL = "admin@taahud.local";
  const state = { client: null };

  function getClient() {
    if (!window._supabase) {
      console.error("[Ta'ahud] Supabase client not initialized — check supabase-config.js");
      return null;
    }
    return window._supabase;
  }

  function showToast(elementId, message, kind) {
    const toast = document.getElementById(elementId);
    toast.textContent = message;
    toast.className = "toast toast-" + (kind || "success");
    toast.hidden = false;
    setTimeout(() => {
      toast.hidden = true;
    }, 4000);
  }

  function showDashboard() {
    document.getElementById("login-view").hidden = true;
    document.getElementById("dashboard-view").hidden = false;
  }

  function showLogin() {
    document.getElementById("login-view").hidden = false;
    document.getElementById("dashboard-view").hidden = true;
  }

  function switchTab(name) {
    document.querySelectorAll(".tabs > .tab[data-tab]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tab === name);
    });
    ["roster", "settings", "stats", "log"].forEach((tab) => {
      document.getElementById("tab-" + tab).hidden = tab !== name;
    });
    if (name === "settings") refreshSettingsForm();
    if (name === "stats") refreshStats();
  }

  async function loadActiveStudents() {
    const { data, error } = await state.client
      .from("students")
      .select("id, code, name, active")
      .eq("active", true)
      .order("code", { ascending: true });
    if (error) {
      console.error("[Ta'ahud] Failed to load students", error);
      return [];
    }
    return data || [];
  }

  async function loadAllStudents() {
    const { data, error } = await state.client
      .from("students")
      .select("id, code, name, active")
      .order("code", { ascending: true });
    if (error) {
      console.error("[Ta'ahud] Failed to load students", error);
      return [];
    }
    return data || [];
  }

  function renderRoster(students) {
    const body = document.getElementById("roster-body");
    body.innerHTML = "";
    students.forEach((student) => {
      const row = document.createElement("tr");

      const codeCell = document.createElement("td");
      codeCell.textContent = student.code;

      const nameCell = document.createElement("td");
      nameCell.textContent = student.name;

      const statusCell = document.createElement("td");
      statusCell.textContent = student.active ? "نشط" : "موقوف";

      const actionCell = document.createElement("td");
      const toggleBtn = document.createElement("button");
      toggleBtn.className = "btn btn-secondary";
      toggleBtn.textContent = student.active ? "إيقاف" : "تفعيل";
      toggleBtn.addEventListener("click", async () => {
        const { error } = await state.client
          .from("students")
          .update({ active: !student.active })
          .eq("id", student.id);
        if (error) {
          showToast("roster-toast", "حصل خطأ أثناء التحديث", "error");
          return;
        }
        await refreshRoster();
      });
      actionCell.appendChild(toggleBtn);

      row.appendChild(codeCell);
      row.appendChild(nameCell);
      row.appendChild(statusCell);
      row.appendChild(actionCell);
      body.appendChild(row);
    });
  }

  async function refreshRoster() {
    const students = await loadAllStudents();
    renderRoster(students);
    return students;
  }

  function wireLogin() {
    const loginForm = document.getElementById("login-form");
    loginForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const password = document.getElementById("admin-password").value;
      const { error } = await state.client.auth.signInWithPassword({ email: ADMIN_EMAIL, password });
      if (error) {
        showToast("login-toast", "كلمة المرور غير صحيحة", "error");
        return;
      }
      showDashboard();
    });

    document.getElementById("logout-btn").addEventListener("click", async () => {
      await state.client.auth.signOut();
      showLogin();
    });
  }

  function wireTabs() {
    document.querySelectorAll(".tabs > .tab[data-tab]").forEach((btn) => {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    });
  }

  function wireAddStudent() {
    document.getElementById("add-student-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const code = document.getElementById("new-code").value.trim();
      const name = document.getElementById("new-name").value.trim();
      if (!code || !name) return;
      const { error } = await state.client.from("students").insert({ code, name, active: true });
      if (error) {
        console.error("[Ta'ahud] Failed to add student", error);
        showToast("roster-toast", "حصل خطأ أثناء الإضافة", "error");
        return;
      }
      document.getElementById("new-code").value = "";
      document.getElementById("new-name").value = "";
      await refreshRoster();
    });
  }

  async function loadPointValue() {
    const { data, error } = await state.client
      .from("settings")
      .select("value")
      .eq("key", "point_value")
      .single();
    if (error || !data) {
      console.error("[Ta'ahud] Failed to load point value", error);
      return 0;
    }
    return Number(data.value && data.value.value) || 0;
  }

  async function savePointValue(newValue) {
    const { error } = await state.client
      .from("settings")
      .update({ value: { value: newValue } })
      .eq("key", "point_value");
    return !error;
  }

  function wireSettings() {
    document.getElementById("settings-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const newValue = Number(document.getElementById("point-value").value);
      const ok = await savePointValue(newValue);
      showToast("settings-toast", ok ? "تم الحفظ" : "حصل خطأ أثناء الحفظ", ok ? "success" : "error");
    });
  }

  async function refreshSettingsForm() {
    document.getElementById("point-value").value = await loadPointValue();
  }

  let statsPeriod = "day";
  let statsSortColumn = "pointsEarned";
  let statsSortDirection = "desc";

  async function loadSessionsForStats() {
    const { data, error } = await state.client
      .from("sessions")
      .select("student_id, listener_type, listener_student_id, pages, points_awarded, created_at");
    if (error) {
      console.error("[Ta'ahud] Failed to load sessions", error);
      return [];
    }
    return data.map((row) => ({
      studentId: row.student_id,
      listenerType: row.listener_type,
      listenerStudentId: row.listener_student_id,
      pages: row.pages,
      pointsAwarded: row.points_awarded,
      createdAt: row.created_at,
    }));
  }

  function renderStatsTable(rows) {
    const body = document.getElementById("stats-body");
    body.innerHTML = "";
    rows.forEach((row) => {
      const tr = document.createElement("tr");
      [row.name, row.sessionsRecited, row.pagesRecited, row.sessionsListened, row.pagesListened, row.pointsEarned].forEach(
        (value) => {
          const td = document.createElement("td");
          td.textContent = value;
          tr.appendChild(td);
        }
      );
      body.appendChild(tr);
    });
  }

  async function refreshStats() {
    const [students, sessions] = await Promise.all([loadActiveStudents(), loadSessionsForStats()]);
    const aggregated = window.TaahudStats.aggregateStudentStats(students, sessions, statsPeriod, new Date());
    const sorted = window.TaahudStats.sortStats(aggregated, statsSortColumn, statsSortDirection);
    renderStatsTable(sorted);
  }

  function wireStatsControls() {
    document.querySelectorAll("#period-tabs > .tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("#period-tabs > .tab").forEach((b) => b.classList.toggle("active", b === btn));
        statsPeriod = btn.dataset.period;
        refreshStats();
      });
    });

    document.querySelectorAll("#stats-table th[data-col]").forEach((th) => {
      th.addEventListener("click", () => {
        const column = th.dataset.col;
        if (statsSortColumn === column) {
          statsSortDirection = statsSortDirection === "asc" ? "desc" : "asc";
        } else {
          statsSortColumn = column;
          statsSortDirection = "desc";
        }
        refreshStats();
      });
    });
  }

  async function init() {
    const client = getClient();
    if (!client) return;
    state.client = client;

    wireLogin();
    wireTabs();
    wireAddStudent();
    wireSettings();
    wireStatsControls();

    const {
      data: { session },
    } = await client.auth.getSession();

    if (session) {
      showDashboard();
      await refreshRoster();
    } else {
      showLogin();
    }
  }

  document.addEventListener("DOMContentLoaded", init);

  return { state, switchTab, loadActiveStudents, refreshRoster };
})();
