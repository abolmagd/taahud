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
    ["overview", "roster", "settings", "stats", "log"].forEach((tab) => {
      document.getElementById("tab-" + tab).hidden = tab !== name;
    });
    document.getElementById("tab-student-detail").hidden = true;
    if (name === "overview") refreshOverview();
    if (name === "roster") refreshRoster();
    if (name === "settings") refreshSettingsForm();
    if (name === "stats") refreshStats();
    if (name === "log") {
      populateLogStudentFilter();
      refreshLog();
    }
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
    return sortStudentsByCode(data || []);
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
    return sortStudentsByCode(data || []);
  }

  function sortStudentsByCode(students) {
    return students.slice().sort((a, b) => {
      const aNumber = Number(a.code);
      const bNumber = Number(b.code);
      if (Number.isFinite(aNumber) && Number.isFinite(bNumber)) return aNumber - bNumber;
      return String(a.code).localeCompare(String(b.code), "ar", { numeric: true });
    });
  }

  function renderRoster(students) {
    const body = document.getElementById("roster-body");
    body.innerHTML = "";
    const activeCount = currentRoster.filter((student) => student.active).length;
    document.getElementById("roster-summary").textContent =
      currentRoster.length + " طالب، " + activeCount + " نشط";
    students.forEach((student) => {
      const row = document.createElement("tr");

      const codeCell = document.createElement("td");
      codeCell.textContent = student.code;

      const nameCell = document.createElement("td");
      nameCell.textContent = student.name;

      const statusCell = document.createElement("td");
      statusCell.textContent = student.active ? "نشط" : "موقوف";

      const actionCell = document.createElement("td");
      actionCell.style.display = "flex";
      actionCell.style.gap = "8px";

      const detailBtn = document.createElement("button");
      detailBtn.className = "btn btn-secondary";
      detailBtn.textContent = "عرض الإحصائيات";
      detailBtn.addEventListener("click", () => showStudentDetail(student));
      actionCell.appendChild(detailBtn);

      const toggleBtn = document.createElement("button");
      toggleBtn.className = "btn btn-secondary";
      toggleBtn.textContent = student.active ? "إيقاف" : "تفعيل";
      toggleBtn.addEventListener("click", async () => {
        const { error } = await state.client
          .from("students")
          .update({ active: !student.active })
          .eq("id", student.id);
        if (error) {
          showToast("roster-toast", "حدث خطأ أثناء التحديث", "error");
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
    if (!students.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 4;
      cell.className = "empty-cell";
      cell.textContent = "لا توجد نتائج مطابقة";
      row.appendChild(cell);
      body.appendChild(row);
    }
  }

  let currentRoster = [];

  function applyRosterFilter() {
    const query = document.getElementById("roster-search").value.trim().toLowerCase();
    if (!query) {
      renderRoster(currentRoster);
      return;
    }
    renderRoster(
      currentRoster.filter(
        (s) => s.code.toLowerCase().includes(query) || s.name.toLowerCase().includes(query)
      )
    );
  }

  function wireRosterSearch() {
    document.getElementById("roster-search").addEventListener("input", applyRosterFilter);
  }

  async function refreshRoster() {
    currentRoster = await loadAllStudents();
    applyRosterFilter();
    return currentRoster;
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
      await refreshRoster();
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
        showToast("roster-toast", "حدث خطأ أثناء الإضافة", "error");
        return;
      }
      document.getElementById("new-code").value = "";
      document.getElementById("new-name").value = "";
      await refreshRoster();
    });
  }

  function getPointRulesFromForm() {
    return window.TaahudPoints.normalizePointRules({
      dailyCheckin: document.getElementById("daily-checkin-points").value,
      reciterPage: document.getElementById("reciter-page-points").value,
      listenerPage: document.getElementById("listener-page-points").value,
    });
  }

  function setPointRulesForm(rules) {
    const normalized = window.TaahudPoints.normalizePointRules(rules);
    document.getElementById("daily-checkin-points").value = normalized.dailyCheckin;
    document.getElementById("reciter-page-points").value = normalized.reciterPage;
    document.getElementById("listener-page-points").value = normalized.listenerPage;
  }

  async function loadPointRules() {
    const { data, error } = await state.client
      .from("settings")
      .select("value")
      .eq("key", "point_rules")
      .maybeSingle();
    if (error || !data) {
      console.warn("[Ta'ahud] Failed to load point rules, using defaults", error);
      return window.TaahudPoints.normalizePointRules();
    }
    return window.TaahudPoints.normalizePointRules(data.value);
  }

  async function savePointRules(rules) {
    const { error } = await state.client
      .from("settings")
      .upsert({ key: "point_rules", value: rules }, { onConflict: "key" });
    return !error;
  }

  function wireSettings() {
    document.getElementById("settings-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const ok = await savePointRules(getPointRulesFromForm());
      showToast("settings-toast", ok ? "تم الحفظ" : "حدث خطأ أثناء الحفظ", ok ? "success" : "error");
    });
  }

  async function refreshSettingsForm() {
    setPointRulesForm(await loadPointRules());
  }

  let statsPeriod = "day";
  let statsSortColumn = "pointsEarned";
  let statsSortDirection = "desc";

  async function loadSessionsForStats() {
    const { data, error } = await state.client
      .from("sessions")
      .select(
        "student_id, listener_type, listener_student_id, pages, points_awarded, listener_points_awarded, created_at"
      );
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
      listenerPointsAwarded: row.listener_points_awarded,
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

  function renderStatsTotals(totals) {
    document.getElementById("total-sessions").textContent = totals.totalSessions;
    document.getElementById("total-pages").textContent = totals.totalPages;
    document.getElementById("total-points").textContent = totals.totalPoints;
    document.getElementById("total-active-students").textContent = totals.activeStudents;
    document.getElementById("total-average-pages").textContent = formatNumber(totals.averagePages);
    document.getElementById("stats-student-listener-sessions").textContent = totals.studentListenerSessions;
    document.getElementById("stats-outside-sessions").textContent = totals.outsideSessions;
    document.getElementById("stats-listening-only-sessions").textContent = totals.listeningOnlySessions;
  }

  async function refreshStats() {
    const [students, sessions] = await Promise.all([loadActiveStudents(), loadSessionsForStats()]);
    const aggregated = window.TaahudStats.aggregateStudentStats(students, sessions, statsPeriod, new Date());
    const sorted = window.TaahudStats.sortStats(aggregated, statsSortColumn, statsSortDirection);
    renderStatsTable(sorted);
    renderStatsTotals(window.TaahudStats.aggregateTotals(sessions, statsPeriod, new Date()));
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

  let allLogSessions = [];

  async function loadSessionsForLog() {
    const { data, error } = await state.client
      .from("sessions")
      .select(
        "id, pages, method, listener_type, created_at, student_id, listener_student_id, " +
          "points_awarded, listener_points_awarded, surah_range, satisfaction, notes, " +
          "student:students!student_id(code, name), listener:students!listener_student_id(code, name)"
      )
      .order("created_at", { ascending: false });
    if (error) {
      console.error("[Ta'ahud] Failed to load session log", error);
      return [];
    }
    return data.map((row) => ({
      id: row.id,
      studentId: row.student_id,
      listenerType: row.listener_type,
      listenerStudentId: row.listener_student_id,
      method: row.method,
      createdAt: row.created_at,
      pages: row.pages,
      pointsAwarded: row.points_awarded,
      listenerPointsAwarded: row.listener_points_awarded,
      surahRange: row.surah_range,
      satisfaction: row.satisfaction,
      notes: row.notes,
      studentLabel: row.student ? row.student.code + " — " + row.student.name : "",
      listenerLabel:
        row.listener_type === "outside"
          ? "شخص آخر خارج تعاهُد"
          : row.listener_type === "listening_only"
          ? "وِرد استماع"
          : row.listener
          ? row.listener.code + " — " + row.listener.name
          : "",
    }));
  }

  function setText(id, value) {
    document.getElementById(id).textContent = value;
  }

  function formatNumber(value) {
    const number = Number(value) || 0;
    if (Number.isInteger(number)) return String(number);
    return number.toFixed(1);
  }

  function shortDate(value) {
    return new Date(value).toLocaleDateString("ar-EG", { day: "numeric", month: "short" });
  }

  function sameLocalDay(a, b) {
    const first = new Date(a);
    const second = new Date(b);
    return (
      first.getFullYear() === second.getFullYear() &&
      first.getMonth() === second.getMonth() &&
      first.getDate() === second.getDate()
    );
  }

  function clearAndEmpty(container, message) {
    container.innerHTML = "";
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = message;
    container.appendChild(empty);
  }

  function renderTopStudents(rows) {
    const container = document.getElementById("overview-top-students");
    container.innerHTML = "";
    if (!rows.length) {
      clearAndEmpty(container, "لا توجد نقاط مسجلة هذا الشهر بعد");
      return;
    }
    rows.forEach((student, index) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "rank-item";
      item.addEventListener("click", () =>
        showStudentDetail({ id: student.studentId, code: student.code, name: student.name, active: true })
      );
      const rankNumber = document.createElement("span");
      rankNumber.className = "rank-number";
      rankNumber.textContent = index + 1;
      const name = document.createElement("span");
      name.className = "rank-name";
      name.textContent = student.code + " — " + student.name;
      const points = document.createElement("strong");
      points.textContent = student.pointsEarned;
      item.append(rankNumber, name, points);
      container.appendChild(item);
    });
  }

  function renderRecentSessions(rows) {
    const container = document.getElementById("overview-recent-sessions");
    container.innerHTML = "";
    if (!rows.length) {
      clearAndEmpty(container, "لم يتم تسجيل جلسات بعد");
      return;
    }
    rows.slice(0, 6).forEach((session) => {
      const item = document.createElement("div");
      item.className = "compact-item";
      const title = document.createElement("span");
      title.className = "compact-title";
      title.textContent = session.studentLabel;
      const meta = document.createElement("span");
      meta.className = "compact-meta";
      meta.textContent = session.pages + " صفحة · " + session.method + " · " + shortDate(session.createdAt);
      item.append(title, meta);
      container.appendChild(item);
    });
  }

  function renderBarList(elementId, rows, valueKey) {
    const container = document.getElementById(elementId);
    container.innerHTML = "";
    if (!rows.length) {
      clearAndEmpty(container, "لا توجد بيانات كافية");
      return;
    }
    const max = Math.max.apply(
      null,
      rows.map((row) => Number(row[valueKey]) || 0)
    );
    rows.slice(0, 5).forEach((row) => {
      const item = document.createElement("div");
      item.className = "bar-row";
      const value = Number(row[valueKey]) || 0;
      const head = document.createElement("div");
      head.className = "bar-row-head";
      const label = document.createElement("span");
      label.textContent = row.label;
      const amount = document.createElement("strong");
      amount.textContent = value;
      head.append(label, amount);
      const track = document.createElement("div");
      track.className = "bar-track";
      const fill = document.createElement("span");
      fill.style.width = (max ? Math.max(8, (value / max) * 100) : 0) + "%";
      track.appendChild(fill);
      item.append(head, track);
      container.appendChild(item);
    });
  }

  function renderDailyActivity(sessions, referenceDate) {
    const container = document.getElementById("overview-daily-activity");
    container.innerHTML = "";
    const days = [];
    const ref = new Date(referenceDate);
    for (let offset = 6; offset >= 0; offset -= 1) {
      const day = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() - offset);
      const daySessions = sessions.filter((session) => sameLocalDay(session.createdAt, day));
      days.push({
        date: day,
        sessions: daySessions.length,
        pages: daySessions.reduce((sum, session) => sum + (Number(session.pages) || 0), 0),
        points: daySessions.reduce(
          (sum, session) => sum + (Number(session.pointsAwarded) || 0) + (Number(session.listenerPointsAwarded) || 0),
          0
        ),
      });
    }
    const maxPoints = Math.max.apply(
      null,
      days.map((day) => day.points)
    );
    days.forEach((day) => {
      const item = document.createElement("div");
      item.className = "activity-day";
      item.innerHTML =
        '<span class="activity-bar" style="height:' +
        (maxPoints ? Math.max(10, (day.points / maxPoints) * 100) : 10) +
        '%"></span><strong>' +
        day.sessions +
        "</strong><small>" +
        shortDate(day.date) +
        "</small>";
      item.title = day.pages + " صفحة · " + day.points + " نقطة";
      container.appendChild(item);
    });
  }

  async function refreshOverview() {
    const [students, sessions] = await Promise.all([loadAllStudents(), loadSessionsForLog()]);
    const activeStudents = students.filter((student) => student.active);
    const now = new Date();
    const todayTotals = window.TaahudStats.aggregateTotals(sessions, "day", now);
    const weekTotals = window.TaahudStats.aggregateTotals(sessions, "week", now);

    setText("overview-today-sessions", todayTotals.totalSessions);
    setText("overview-today-pages", todayTotals.totalPages + " صفحة");
    setText("overview-today-points", todayTotals.totalPoints);
    setText("overview-today-active", todayTotals.activeStudents + " طالب نشط");
    setText("overview-week-sessions", weekTotals.totalSessions);
    setText("overview-week-pages", weekTotals.totalPages + " صفحة");
    setText("overview-total-students", students.length);
    setText("overview-active-students", activeStudents.length + " نشط");

    renderDailyActivity(sessions, now);
    renderTopStudents(window.TaahudStats.topStudents(activeStudents, sessions, "month", now, 6));
    renderRecentSessions(sessions);
    renderBarList("overview-methods", window.TaahudStats.aggregateByField(sessions, "month", now, "method", "غير محدد"), "sessions");
    renderBarList(
      "overview-satisfaction",
      window.TaahudStats.aggregateByField(sessions, "month", now, "satisfaction", "غير محدد"),
      "sessions"
    );
  }

  function renderLogTable(rows) {
    const body = document.getElementById("log-body");
    body.innerHTML = "";
    rows.forEach((row) => {
      const tr = document.createElement("tr");
      [
        new Date(row.createdAt).toLocaleString("ar-EG"),
        row.studentLabel,
        row.listenerLabel,
        row.pages,
        row.surahRange || "",
        row.method,
        row.pointsAwarded || 0,
        row.listenerPointsAwarded || 0,
        row.satisfaction || "",
        row.notes || "",
      ].forEach((value) => {
        const td = document.createElement("td");
        td.textContent = value;
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });
  }

  function applyLogFilters() {
    const studentId = document.getElementById("log-filter-student").value;
    const method = document.getElementById("log-filter-method").value;
    const filtered = window.TaahudSessionLog.filterSessions(allLogSessions, { studentId, method });
    renderLogTable(filtered);
  }

  async function refreshLog() {
    allLogSessions = await loadSessionsForLog();
    applyLogFilters();
  }

  async function populateLogStudentFilter() {
    const students = await loadActiveStudents();
    const select = document.getElementById("log-filter-student");
    select.innerHTML = '<option value="">كل الطلاب</option>';
    students.forEach((s) => {
      const opt = document.createElement("option");
      opt.value = s.id;
      opt.textContent = s.code + " — " + s.name;
      select.appendChild(opt);
    });
  }

  function wireLogControls() {
    document.getElementById("log-filter-student").addEventListener("change", applyLogFilters);
    document.getElementById("log-filter-method").addEventListener("change", applyLogFilters);
  }

  // Sessions where the given student appears either as reciter or as
  // listener, labeled with their role and the counterpart's name.
  // Order follows loadSessionsForLog's created_at-descending fetch.
  function sessionsForStudent(student, sessions) {
    return sessions
      .filter((s) => s.studentId === student.id || (s.listenerType === "student" && s.listenerStudentId === student.id))
      .map((s) => {
        const isReciter = s.studentId === student.id;
        return {
          createdAt: s.createdAt,
          role: isReciter ? "مُسمِّع" : "سامع",
          counterpart: isReciter ? s.listenerLabel : s.studentLabel,
          pages: s.pages,
          surahRange: s.surahRange,
          method: s.method,
          points: isReciter ? s.pointsAwarded || 0 : s.listenerPointsAwarded || 0,
          satisfaction: s.satisfaction,
          notes: s.notes,
        };
      });
  }

  function renderStudentDetailTable(rows) {
    const body = document.getElementById("student-detail-body");
    body.innerHTML = "";
    rows.forEach((row) => {
      const tr = document.createElement("tr");
      [
        new Date(row.createdAt).toLocaleString("ar-EG"),
        row.role,
        row.counterpart,
        row.pages,
        row.surahRange || "",
        row.method,
        row.points,
        row.satisfaction || "",
        row.notes || "",
      ].forEach((value) => {
        const td = document.createElement("td");
        td.textContent = value;
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });
  }

  async function showStudentDetail(student) {
    document.getElementById("tab-roster").hidden = true;
    document.getElementById("tab-student-detail").hidden = false;
    document.getElementById("student-detail-title").textContent = student.code + " — " + student.name;

    const sessions = await loadSessionsForLog();
    const stats = window.TaahudStats.aggregateStudentStats([student], sessions, "all", new Date())[0];
    document.getElementById("student-detail-sessions-recited").textContent = stats.sessionsRecited;
    document.getElementById("student-detail-pages-recited").textContent = stats.pagesRecited;
    document.getElementById("student-detail-sessions-listened").textContent = stats.sessionsListened;
    document.getElementById("student-detail-pages-listened").textContent = stats.pagesListened;
    document.getElementById("student-detail-points").textContent = stats.pointsEarned;

    renderStudentDetailTable(sessionsForStudent(student, sessions));
  }

  function hideStudentDetail() {
    document.getElementById("tab-student-detail").hidden = true;
    document.getElementById("tab-roster").hidden = false;
  }

  function wireStudentDetail() {
    document.getElementById("student-detail-back").addEventListener("click", hideStudentDetail);
  }

  async function init() {
    const client = getClient();
    if (!client) return;
    state.client = client;

    wireLogin();
    wireTabs();
    wireAddStudent();
    wireRosterSearch();
    wireStudentDetail();
    wireSettings();
    wireStatsControls();
    wireLogControls();

    const {
      data: { session },
    } = await client.auth.getSession();

    if (session) {
      showDashboard();
      await refreshOverview();
    } else {
      showLogin();
    }
  }

  document.addEventListener("DOMContentLoaded", init);

  return { state, switchTab, loadActiveStudents, refreshRoster };
})();
