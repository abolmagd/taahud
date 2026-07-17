"use strict";

window.TaahudAdmin = (function () {
  const ADMIN_EMAIL = "admin@taahud.local";
  const LIVE_REFRESH_DEBOUNCE_MS = 350;
  const LIVE_POLL_INTERVAL_MS = 15000;
  const AT_RISK_PREVIEW_LIMIT = 8;
  const state = { client: null, credentials: [], logPage: 1, logPageSize: 25, filteredLogSessions: [] };
  let adminChangesChannel = null;
  let liveRefreshTimer = null;
  let pollingTimer = null;
  let currentAtRiskStudents = [];

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
    toast.setAttribute("role", kind === "error" ? "alert" : "status");
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
      const active = btn.dataset.tab === name;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-selected", String(active));
    });
    ["overview", "roster", "settings", "stats", "log"].forEach((tab) => {
      document.getElementById("tab-" + tab).hidden = tab !== name;
    });
    document.getElementById("tab-student-detail").hidden = true;
    const panel = document.getElementById("tab-" + name);
    panel.setAttribute("tabindex", "-1");
    panel.focus({ preventScroll: true });
    if (name === "settings") refreshSettingsForm();
    else refreshActivePanels().catch((error) => console.error("[Ta'ahud] Failed to switch admin tab", error));
  }

  async function loadActiveStudents() {
    const { data, error } = await state.client
      .from("students")
      .select("id, code, name, active, created_at")
      .eq("active", true)
      .order("code", { ascending: true });
    if (error) {
      console.error("[Ta'ahud] Failed to load students", error);
      return [];
    }
    return sortStudentsByCode((data || []).map((student) => Object.assign({}, student, { createdAt: student.created_at })));
  }

  async function loadAllStudents() {
    const { data, error } = await state.client
      .from("students")
      .select("id, code, name, active, created_at")
      .order("code", { ascending: true });
    if (error) {
      console.error("[Ta'ahud] Failed to load students", error);
      return [];
    }
    return sortStudentsByCode((data || []).map((student) => Object.assign({}, student, { createdAt: student.created_at })));
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

      const pointsCell = document.createElement("td");
      pointsCell.textContent = formatNumber(student.totalPoints);

      const lastActivityCell = document.createElement("td");
      lastActivityCell.textContent = student.lastActivity
        ? new Date(student.lastActivity).toLocaleString("ar-EG", { dateStyle: "medium", timeStyle: "short" })
        : "لا يوجد نشاط";

      const actionCell = document.createElement("td");
      actionCell.style.display = "flex";
      actionCell.style.gap = "8px";
      actionCell.style.flexWrap = "wrap";

      const detailBtn = document.createElement("button");
      detailBtn.className = "btn btn-secondary";
      detailBtn.textContent = "عرض الإحصائيات";
      detailBtn.addEventListener("click", () => showStudentDetail(student));
      actionCell.appendChild(detailBtn);

      const toggleBtn = document.createElement("button");
      toggleBtn.className = "btn btn-secondary";
      toggleBtn.textContent = student.active ? "إيقاف" : "تفعيل";
      toggleBtn.addEventListener("click", async () => {
        const action = student.active ? "إيقاف" : "تفعيل";
        if (!window.confirm(action + " حساب الطالب " + student.code + "؟")) return;
        const reason = window.prompt("سبب " + action + " الحساب (اختياري):") || null;
        const { error } = await state.client.rpc("set_student_active", {
          target_student_id: student.id,
          next_active: !student.active,
          change_reason: reason,
        });
        if (error) {
          showToast("roster-toast", "حدث خطأ أثناء التحديث", "error");
          return;
        }
        await refreshRoster();
      });
      actionCell.appendChild(toggleBtn);

      const resetPasswordBtn = document.createElement("button");
      resetPasswordBtn.className = "btn btn-secondary";
      resetPasswordBtn.textContent = "إعادة كلمة المرور";
      resetPasswordBtn.addEventListener("click", async () => {
        const confirmed = window.confirm(
          "إعادة كلمة مرور الطالب " + student.code + " إلى 123456789؟ ستنتهي أي جلسة مفتوحة له."
        );
        if (!confirmed) return;

        resetPasswordBtn.disabled = true;
        const { data, error } = await state.client.rpc("reset_student_password", {
          target_student_id: student.id,
        });
        resetPasswordBtn.disabled = false;

        if (error) {
          console.error("[Ta'ahud] Failed to reset student password", error);
          showToast("roster-toast", "حدث خطأ أثناء إعادة كلمة المرور", "error");
          return;
        }

        showCredentials([data]);
        showToast("roster-toast", "تمت إعادة كلمة المرور إلى 123456789", "success");
        await refreshRoster();
      });
      actionCell.appendChild(resetPasswordBtn);

      const resetPointsBtn = document.createElement("button");
      resetPointsBtn.className = "btn btn-danger";
      resetPointsBtn.textContent = "تصفير النقاط";
      resetPointsBtn.dataset.action = "reset-student-points";
      resetPointsBtn.addEventListener("click", async () => {
        if (Number(student.totalPoints) <= 0) {
          showToast("roster-toast", "رصيد هذا الطالب صفر بالفعل", "success");
          return;
        }

        const confirmed = window.confirm(
          "سيتم تصفير " + formatNumber(student.totalPoints) + " نقطة للطالب " + student.code +
          ". ستظل الجلسات والسجلات محفوظة. هل تريد الاستمرار؟"
        );
        if (!confirmed) return;

        const reasonInput = window.prompt("اكتب سبب تصفير نقاط الطالب (إلزامي):");
        if (reasonInput === null) return;
        const reason = reasonInput.trim();
        if (!reason) {
          showToast("roster-toast", "يجب كتابة سبب التصفير", "error");
          return;
        }

        resetPointsBtn.disabled = true;
        const { data, error } = await state.client.rpc("admin_reset_student_points", {
          target_student_id: student.id,
          change_reason: reason,
        });
        resetPointsBtn.disabled = false;

        if (error) {
          console.error("[Ta'ahud] Failed to reset student points", error);
          showToast("roster-toast", "حدث خطأ أثناء تصفير النقاط", "error");
          return;
        }

        showToast(
          "roster-toast",
          "تم تصفير " + formatNumber(data && data.removedPoints) + " نقطة للطالب " + student.code,
          "success"
        );
        await refreshRoster();
      });
      actionCell.appendChild(resetPointsBtn);

      row.appendChild(codeCell);
      row.appendChild(nameCell);
      row.appendChild(statusCell);
      row.appendChild(pointsCell);
      row.appendChild(lastActivityCell);
      row.appendChild(actionCell);
      body.appendChild(row);
    });
    if (!students.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 6;
      cell.className = "empty-cell";
      cell.textContent = "لا توجد نتائج مطابقة";
      row.appendChild(cell);
      body.appendChild(row);
    }
  }

  let currentRoster = [];
  let currentDetailStudent = null;

  function applyRosterFilter() {
    const query = document.getElementById("roster-search").value.trim().toLowerCase();
    const matching = query
      ? currentRoster.filter(
        (s) => s.code.toLowerCase().includes(query) || s.name.toLowerCase().includes(query)
      )
      : currentRoster;
    renderRoster(window.TaahudStats.sortStudentRoster(matching, document.getElementById("roster-sort").value));
  }

  function wireRosterSearch() {
    document.getElementById("roster-search").addEventListener("input", applyRosterFilter);
    document.getElementById("roster-sort").addEventListener("change", applyRosterFilter);
  }

  async function refreshRoster() {
    const [students, sessions] = await Promise.all([loadAllStudents(), loadSessionsForStats()]);
    currentRoster = window.TaahudStats.enrichStudentRoster(students, sessions);
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
      startAdminLiveUpdates();
      await refreshOverview();
    });

    document.getElementById("logout-btn").addEventListener("click", async () => {
      stopAdminLiveUpdates();
      await state.client.auth.signOut();
      showLogin();
    });
  }

  function wireTabs() {
    const tabs = Array.from(document.querySelectorAll(".tabs > .tab[data-tab]"));
    tabs.forEach((btn, index) => {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab));
      btn.addEventListener("keydown", (event) => {
        if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        event.preventDefault();
        const delta = event.key === 'ArrowLeft' ? 1 : -1;
        tabs[(index + delta + tabs.length) % tabs.length].focus();
      });
    });
  }

  function wireAddStudent() {
    document.getElementById("add-student-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const code = document.getElementById("new-code").value.trim();
      const name = document.getElementById("new-name").value.trim();
      if (!code || !name) return;
      const { data, error } = await state.client.rpc("create_student_with_temp_password", {
        p_code: code,
        p_name: name,
      });
      if (error) {
        console.error("[Ta'ahud] Failed to add student", error);
        showToast("roster-toast", "حدث خطأ أثناء الإضافة", "error");
        return;
      }
      document.getElementById("new-code").value = "";
      document.getElementById("new-name").value = "";
      showCredentials([data]);
      await refreshRoster();
    });
  }

  function escapeCsv(value) {
    const text = String(value == null ? "" : value);
    return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  }

  function downloadCsv(filename, headers, rows) {
    const csv = "\uFEFF" + [headers, ...rows].map((row) => row.map(escapeCsv).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  function showCredentials(credentials) {
    state.credentials = (credentials || []).filter(Boolean);
    const body = document.getElementById("credentials-body");
    body.innerHTML = "";
    state.credentials.forEach((item) => {
      const row = document.createElement("tr");
      [item.code, item.name, item.temporaryPassword || item.temporary_password].forEach((value) => {
        const cell = document.createElement("td");
        cell.textContent = value || "";
        row.appendChild(cell);
      });
      body.appendChild(row);
    });
    document.getElementById("credentials-dialog").showModal();
  }

  function parseStudentCsv(text) {
    return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line, index) => {
      const cells = line.split(",").map((cell) => cell.trim().replace(/^"|"$/g, ""));
      if (index === 0 && /code|كود/i.test(cells[0])) return null;
      return { code: cells[0], name: cells.slice(1).join(" ") };
    }).filter((row) => row && row.code && row.name);
  }

  function wireRosterTools() {
    document.getElementById("close-credentials-btn").addEventListener("click", () => document.getElementById("credentials-dialog").close());
    document.getElementById("export-credentials-btn").addEventListener("click", () => {
      downloadCsv("taahud-default-passwords.csv", ["code", "name", "default_password"],
        state.credentials.map((item) => [item.code, item.name, item.temporaryPassword || item.temporary_password]));
    });
    document.getElementById("rotate-passwords-btn").addEventListener("click", async () => {
      if (!window.confirm("سيتم ضبط كلمة المرور الافتراضية 123456789 لكل الحسابات التي لم تغيّرها بعد. استمر؟")) return;
      const { data, error } = await state.client.rpc("rotate_unclaimed_student_passwords");
      if (error) return showToast("roster-toast", "تعذر ضبط كلمات المرور", "error");
      if (!data.length) return showToast("roster-toast", "لا توجد حسابات تحتاج إلى إعادة ضبط", "success");
      showCredentials(data);
    });
    document.getElementById("reset-all-points-btn").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      if (!window.confirm(
        "سيتم تصفير نقاط كل الطلاب نهائيًا مع الاحتفاظ بكل الجلسات والسجلات. هل تريد الاستمرار؟"
      )) return;

      const confirmation = window.prompt('للتأكيد اكتب كلمة "تصفير" كما هي:');
      if (confirmation === null) return;
      if (confirmation.trim() !== "تصفير") {
        showToast("roster-toast", "لم يتم التنفيذ لأن كلمة التأكيد غير صحيحة", "error");
        return;
      }

      const reasonInput = window.prompt("اكتب سبب تصفير نقاط الجميع (إلزامي):");
      if (reasonInput === null) return;
      const reason = reasonInput.trim();
      if (!reason) {
        showToast("roster-toast", "يجب كتابة سبب التصفير", "error");
        return;
      }

      button.disabled = true;
      const { data, error } = await state.client.rpc("admin_reset_all_points", { change_reason: reason });
      button.disabled = false;

      if (error) {
        console.error("[Ta'ahud] Failed to reset all points", error);
        showToast("roster-toast", "حدث خطأ أثناء تصفير نقاط الجميع", "error");
        return;
      }

      showToast(
        "roster-toast",
        "تم تصفير " + formatNumber(data && data.removedPoints) + " نقطة من جميع الحسابات",
        "success"
      );
      await refreshRoster();
    });
    document.getElementById("import-students-btn").addEventListener("click", async () => {
      const file = document.getElementById("bulk-student-file").files[0];
      if (!file) return showToast("roster-toast", "اختر ملف CSV أولًا", "error");
      const rows = parseStudentCsv(await file.text());
      const credentials = [];
      for (const row of rows) {
        const { data, error } = await state.client.rpc("create_student_with_temp_password", { p_code: row.code, p_name: row.name });
        if (error) {
          showToast("roster-toast", "توقف الاستيراد عند الكود " + row.code, "error");
          break;
        }
        credentials.push(data);
      }
      if (credentials.length) showCredentials(credentials);
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

  async function savePointRules(rules, reason) {
    return state.client.rpc("admin_update_point_rules", {
      p_daily_checkin: rules.dailyCheckin,
      p_reciter_page: rules.reciterPage,
      p_listener_page: rules.listenerPage,
      change_reason: reason,
    });
  }

  function cairoDate() {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(new Date());
    const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
    return new Date(Number(values.year), Number(values.month) - 1, Number(values.day));
  }

  function setAdminLoading(loading) {
    document.getElementById("admin-loading").hidden = !loading;
    if (!loading) {
      document.getElementById("admin-last-updated").textContent =
        "آخر تحديث " + new Date().toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit" });
    }
  }

  function activeTabName() {
    const active = document.querySelector(".tabs > .tab[data-tab].active");
    return active ? active.dataset.tab : "overview";
  }

  async function refreshActivePanels() {
    setAdminLoading(true);
    const tab = activeTabName();
    try {
      if (tab === "overview") await refreshOverview();
      if (tab === "roster") await refreshRoster();
      if (tab === "stats") await refreshStats();
      if (tab === "log") {
        await populateLogStudentFilter();
        await refreshLog();
      }
      if (!document.getElementById("tab-student-detail").hidden && currentDetailStudent) {
        await showStudentDetail(currentDetailStudent);
      }
    } finally {
      setAdminLoading(false);
    }
  }

  function scheduleLiveRefresh() {
    if (document.getElementById("dashboard-view").hidden) return;
    clearTimeout(liveRefreshTimer);
    liveRefreshTimer = setTimeout(() => {
      refreshActivePanels().catch((error) => {
        console.error("[Ta'ahud] Failed to refresh live admin panels", error);
      });
    }, LIVE_REFRESH_DEBOUNCE_MS);
  }

  function subscribeAdminLiveUpdates() {
    if (adminChangesChannel || !state.client.channel) return;

    adminChangesChannel = state.client
      .channel("taahud-admin-live-updates")
      .on("postgres_changes", { event: "*", schema: "public", table: "sessions" }, scheduleLiveRefresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "students" }, scheduleLiveRefresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "settings" }, scheduleLiveRefresh)
      .subscribe((status) => {
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          console.warn("[Ta'ahud] Realtime admin updates are not connected:", status);
        }
      });
  }

  function unsubscribeAdminLiveUpdates() {
    if (!adminChangesChannel) return;
    state.client.removeChannel(adminChangesChannel);
    adminChangesChannel = null;
  }

  function startLivePollingFallback() {
    if (pollingTimer) return;
    pollingTimer = setInterval(scheduleLiveRefresh, LIVE_POLL_INTERVAL_MS);
  }

  function stopLivePollingFallback() {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }

  function startAdminLiveUpdates() {
    subscribeAdminLiveUpdates();
    startLivePollingFallback();
  }

  function stopAdminLiveUpdates() {
    clearTimeout(liveRefreshTimer);
    liveRefreshTimer = null;
    stopLivePollingFallback();
    unsubscribeAdminLiveUpdates();
  }

  function wireSettings() {
    document.getElementById("settings-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const rules = getPointRulesFromForm();
      if (!window.confirm(
        "سيتم إعادة حساب نقاط كل الجلسات القديمة والجديدة بالقواعد الحالية. " +
        "هذا سيستبدل أي تصفير أو تعديل يدوي سابق للنقاط. هل تريد الاستمرار؟"
      )) return;

      const reasonInput = window.prompt("اكتب سبب تغيير قواعد النقاط (إلزامي):");
      if (reasonInput === null) return;
      const reason = reasonInput.trim();
      if (!reason) {
        showToast("settings-toast", "يجب كتابة سبب تغيير النقاط", "error");
        return;
      }

      const submitButton = event.currentTarget.querySelector('button[type="submit"]');
      submitButton.disabled = true;
      const { data, error } = await savePointRules(rules, reason);
      submitButton.disabled = false;

      if (error) {
        console.error("[Ta'ahud] Failed to update point rules", error);
        showToast("settings-toast", "حدث خطأ أثناء حفظ وإعادة حساب النقاط", "error");
        return;
      }

      showToast(
        "settings-toast",
        "تم الحفظ وإعادة حساب " + formatNumber(data && data.updatedSessions) +
          " جلسة. إجمالي النقاط الآن " + formatNumber(data && data.newTotalPoints),
        "success"
      );
      await refreshSettingsForm();
    });
  }

  async function refreshSettingsForm() {
    setPointRulesForm(await loadPointRules());
  }

  let statsPeriod = "day";
  let statsSortColumn = "pointsEarned";
  let statsSortDirection = "desc";

  async function fetchAllSessionRows(selectClause, ordered) {
    const pageSize = 1000;
    const rows = [];
    for (let offset = 0; ; offset += pageSize) {
      let query = state.client.from("sessions").select(selectClause).is("deleted_at", null);
      if (ordered) {
        query = query.order("session_date", { ascending: false }).order("created_at", { ascending: false });
      }
      const { data, error } = await query.range(offset, offset + pageSize - 1);
      if (error) throw error;
      rows.push(...(data || []));
      if (!data || data.length < pageSize) break;
    }
    return rows;
  }

  async function loadSessionsForStats() {
    try {
      const data = await fetchAllSessionRows(
        "student_id, listener_type, listener_student_id, pages, points_awarded, listener_points_awarded, session_date, created_at"
      );
      return data.map((row) => ({
        studentId: row.student_id,
        listenerType: row.listener_type,
        listenerStudentId: row.listener_student_id,
        pages: row.pages,
        pointsAwarded: row.points_awarded,
        listenerPointsAwarded: row.listener_points_awarded,
        sessionDate: row.session_date,
        createdAt: row.created_at,
      }));
    } catch (error) {
      console.error("[Ta'ahud] Failed to load sessions", error);
      return [];
    }
  }

  function renderStatsTable(rows) {
    const body = document.getElementById("stats-body");
    body.innerHTML = "";
    rows.forEach((row) => {
      const tr = document.createElement("tr");
      [row.name, row.active ? "نشط" : "موقوف", row.sessionsRecited, row.pagesRecited, row.sessionsListened, row.pagesListened, row.pointsEarned].forEach(
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
    document.getElementById("total-median-pages").textContent = formatNumber(totals.medianPages || 0);
    document.getElementById("stats-student-listener-sessions").textContent = totals.studentListenerSessions;
    document.getElementById("stats-outside-sessions").textContent = totals.outsideSessions;
    document.getElementById("stats-listening-only-sessions").textContent = totals.listeningOnlySessions;
  }

  async function refreshStats() {
    const [students, sessions] = await Promise.all([
      loadAllStudents(),
      loadSessionsForStats(),
    ]);
    const now = cairoDate();
    const activeById = new Map(students.map((student) => [student.id, student.active]));
    const aggregated = window.TaahudStats.aggregateStudentStats(students, sessions, statsPeriod, now)
      .map((row) => Object.assign(row, { active: activeById.get(row.studentId) !== false }));
    const sorted = window.TaahudStats.sortStats(aggregated, statsSortColumn, statsSortDirection);
    renderStatsTable(sorted);
    renderStatsTotals(window.TaahudStats.aggregateTotals(sessions, statsPeriod, now));
  }

  function wireStatsControls() {
    document.querySelectorAll("#period-tabs > .tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("#period-tabs > .tab").forEach((b) => {
          b.classList.toggle("active", b === btn);
          b.setAttribute("aria-pressed", String(b === btn));
        });
        statsPeriod = btn.dataset.period;
        refreshStats();
      });
    });

    document.querySelectorAll("#stats-table .sort-button[data-col]").forEach((button) => {
      button.addEventListener("click", () => {
        const column = button.dataset.col;
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
    try {
      const data = await fetchAllSessionRows(
        "id, pages, method, listener_type, created_at, student_id, listener_student_id, " +
          "points_awarded, listener_points_awarded, session_date, session_timing, surah_range, satisfaction, notes, " +
          "student:students!student_id(code, name), listener:students!listener_student_id(code, name)",
        true
      );
      return data.map((row) => ({
        id: row.id,
        studentId: row.student_id,
        listenerType: row.listener_type,
        listenerStudentId: row.listener_student_id,
        method: row.method,
        createdAt: row.created_at,
        sessionDate: row.session_date,
        sessionTiming: row.session_timing,
        pages: row.pages,
        pointsAwarded: row.points_awarded,
        listenerPointsAwarded: row.listener_points_awarded,
        surahRange: row.surah_range,
        satisfaction: row.satisfaction,
        notes: row.notes,
        studentLabel: row.student ? row.student.code + " — " + row.student.name : "",
        listenerLabel: row.listener_type === "outside" ? "شخص آخر خارج تعاهُد"
          : row.listener_type === "listening_only" ? "وِرد استماع"
          : row.listener ? row.listener.code + " — " + row.listener.name : "",
      }));
    } catch (error) {
      console.error("[Ta'ahud] Failed to load session log", error);
      return [];
    }
  }

  function setText(id, value) {
    document.getElementById(id).textContent = value;
  }

  function formatNumber(value) {
    const number = Number(value) || 0;
    if (Number.isInteger(number)) return String(number);
    return number.toFixed(1);
  }

  function applyBrandTextIfNeeded(element, value) {
    if (String(value).includes("تعاه")) {
      element.classList.add("brand-text");
    }
  }

  function shortDate(value) {
    return new Date(value).toLocaleDateString("ar-EG", { day: "numeric", month: "short" });
  }

  function shortWeekday(value) {
    return new Date(value).toLocaleDateString("ar-EG", { weekday: "short" });
  }

  function sessionDisplayDate(session) {
    return session.sessionDate || session.createdAt;
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
      meta.textContent = session.pages + " صفحة · " + session.method + " · " + shortDate(sessionDisplayDate(session));
      item.append(title, meta);
      container.appendChild(item);
    });
  }

  function atRiskActivityLabel(student) {
    if (!student.lastActivity) return "لم يسجل أي جلسة من قبل";
    return "آخر نشاط: " + new Date(student.lastActivity).toLocaleDateString("ar-EG", {
      day: "numeric", month: "long", year: "numeric",
    });
  }

  function createAtRiskItem(student, dialogItem) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = dialogItem ? "followup-item" : "compact-item compact-item-button";

    const title = document.createElement("span");
    title.className = dialogItem ? "followup-item-title" : "compact-title";
    title.textContent = student.code + " - " + student.name;

    const meta = document.createElement("span");
    meta.className = dialogItem ? "followup-item-meta" : "compact-meta";
    meta.textContent = atRiskActivityLabel(student);

    item.append(title, meta);
    item.addEventListener("click", () => {
      const dialog = document.getElementById("at-risk-dialog");
      if (dialog.open) dialog.close();
      showStudentDetail(student);
    });
    return item;
  }

  function renderAtRiskDialog() {
    const list = document.getElementById("at-risk-dialog-list");
    list.innerHTML = "";
    currentAtRiskStudents.forEach((student) => list.appendChild(createAtRiskItem(student, true)));
    document.getElementById("at-risk-dialog-summary").textContent =
      currentAtRiskStudents.length + " طالب نشط لم يسجلوا خلال آخر ٧ أيام";
  }

  function wireAtRiskDialog() {
    const dialog = document.getElementById("at-risk-dialog");
    document.getElementById("overview-at-risk-more").addEventListener("click", () => {
      renderAtRiskDialog();
      dialog.showModal();
    });
    document.getElementById("close-at-risk-dialog").addEventListener("click", () => dialog.close());
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
    container.setAttribute("role", "list");
    container.setAttribute("aria-label", "نشاط آخر سبعة أيام بالنقاط والجلسات والصفحات");
    const days = [];
    const ref = new Date(referenceDate);
    for (let offset = 6; offset >= 0; offset -= 1) {
      const day = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() - offset);
      const daySessions = sessions.filter((session) => sameLocalDay(sessionDisplayDate(session), day));
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
      item.setAttribute("role", "listitem");
      const level = day.points && maxPoints ? Math.max(0.12, day.points / maxPoints) : 0;
      item.style.setProperty("--activity-level", level);
      item.classList.toggle("activity-day-empty", day.points === 0);
      item.setAttribute(
        "aria-label",
        shortWeekday(day.date) + "، " + shortDate(day.date) + "، " + day.points +
          " نقطة، " + day.sessions + " جلسة، " + formatNumber(day.pages) + " صفحة"
      );

      const plot = document.createElement("div");
      plot.className = "activity-plot";
      plot.setAttribute("aria-hidden", "true");
      const value = document.createElement("strong");
      value.className = "activity-value";
      value.textContent = formatNumber(day.points);
      const track = document.createElement("div");
      track.className = "activity-track";
      const bar = document.createElement("span");
      bar.className = "activity-bar";
      track.appendChild(bar);
      plot.append(value, track);

      const meta = document.createElement("div");
      meta.className = "activity-day-meta";
      const weekday = document.createElement("strong");
      weekday.textContent = shortWeekday(day.date);
      const date = document.createElement("small");
      date.textContent = shortDate(day.date);
      meta.append(weekday, date);

      const summary = document.createElement("small");
      summary.className = "activity-day-summary";
      summary.textContent = day.sessions + " جلسة · " + formatNumber(day.pages) + " صفحة";

      item.append(plot, meta, summary);
      container.appendChild(item);
    });
  }

  async function refreshOverview() {
    const [students, sessions] = await Promise.all([loadAllStudents(), loadSessionsForLog()]);
    const activeStudents = students.filter((student) => student.active);
    const now = cairoDate();
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

    const currentWeekStart = window.TaahudStats.periodBounds("week", now).start;
    const previousWeekRef = new Date(currentWeekStart);
    previousWeekRef.setDate(previousWeekRef.getDate() - 1);
    const previousWeekTotals = window.TaahudStats.aggregateTotals(sessions, "week", previousWeekRef);
    const change = previousWeekTotals.totalSessions
      ? Math.round(((weekTotals.totalSessions - previousWeekTotals.totalSessions) / previousWeekTotals.totalSessions) * 100)
      : weekTotals.totalSessions ? 100 : 0;
    setText("overview-week-change", (change > 0 ? "+" : "") + change + "%");
    setText("overview-week-change-label", change > 0 ? "تحسن" : change < 0 ? "انخفاض" : "لا تغيير");

    const recentCutoff = new Date(now);
    recentCutoff.setDate(recentCutoff.getDate() - 6);
    const recentSessions = sessions.filter((session) => new Date(sessionDisplayDate(session)) >= recentCutoff);
    const recentIds = new Set();
    recentSessions.forEach((session) => {
      recentIds.add(session.studentId);
      if (session.listenerType === "student") recentIds.add(session.listenerStudentId);
    });
    const latestActivity = new Map();
    sessions.forEach((session) => {
      const activity = new Date(sessionDisplayDate(session)).getTime();
      if (!Number.isFinite(activity)) return;
      const participantIds = [session.studentId];
      if (session.listenerType === "student") participantIds.push(session.listenerStudentId);
      participantIds.forEach((studentId) => {
        if (studentId && (!latestActivity.has(studentId) || activity > latestActivity.get(studentId))) {
          latestActivity.set(studentId, activity);
        }
      });
    });
    currentAtRiskStudents = activeStudents
      .filter((student) => !recentIds.has(student.id))
      .map((student) => Object.assign({}, student, { lastActivity: latestActivity.get(student.id) || null }))
      .sort((a, b) => {
        if (!a.lastActivity && b.lastActivity) return -1;
        if (a.lastActivity && !b.lastActivity) return 1;
        const activityDifference = (a.lastActivity || 0) - (b.lastActivity || 0);
        if (activityDifference) return activityDifference;
        return sortStudentsByCode([a, b])[0] === a ? -1 : 1;
      });
    setText("overview-at-risk-count", currentAtRiskStudents.length);
    const atRiskContainer = document.getElementById("overview-at-risk-students");
    atRiskContainer.innerHTML = "";
    if (!currentAtRiskStudents.length) clearAndEmpty(atRiskContainer, "كل الطلاب لديهم نشاط خلال آخر ٧ أيام");
    currentAtRiskStudents.slice(0, AT_RISK_PREVIEW_LIMIT).forEach((student) => {
      atRiskContainer.appendChild(createAtRiskItem(student, false));
    });
    const moreButton = document.getElementById("overview-at-risk-more");
    moreButton.hidden = currentAtRiskStudents.length <= AT_RISK_PREVIEW_LIMIT;
    moreButton.textContent = "إظهار المزيد (" + currentAtRiskStudents.length + ")";
    if (document.getElementById("at-risk-dialog").open) renderAtRiskDialog();

    renderDailyActivity(sessions, now);
    renderTopStudents(window.TaahudStats.topStudents(activeStudents, sessions, "month", now, 6));
    renderRecentSessions(sessions);
    renderBarList("overview-methods", window.TaahudStats.aggregateByField(sessions, "month", now, "method", "غير محدد"), "sessions");
    renderBarList(
      "overview-satisfaction",
      window.TaahudStats.aggregateByField(sessions, "month", now, "satisfaction", "غير محدد"),
      "sessions"
    );
    renderBarList("overview-streaks", window.TaahudStats.streakDistribution(activeStudents, sessions, now), "sessions");

    const validMethods = new Set(["تليجرام", "واتس", "مكالمة هاتفية", "جوجل ميت", "مقابلة", "استماع", "أخرى"]);
    const validSatisfaction = new Set(["نعم تماما", "يحتاج إلى مزيد من الضبط", "وردي كان ورد استماع"]);
    const qualityIssues = sessions.reduce((count, session) => count + (
      Number(session.pages) <= 0 || Number(session.pages) > 100 ||
      !validMethods.has(session.method) || !validSatisfaction.has(session.satisfaction) ||
      (session.listenerType === "student" && session.studentId === session.listenerStudentId) ? 1 : 0
    ), 0);
    setText("overview-quality-issues", qualityIssues);
    setText("overview-quality-label", qualityIssues ? "راجع هذه السجلات من تبويب السجلات" : "لا توجد مشكلات مكتشفة");
  }

  function renderLogTable(rows) {
    const body = document.getElementById("log-body");
    body.innerHTML = "";
    rows.forEach((row) => {
      const tr = document.createElement("tr");
      [
        new Date(sessionDisplayDate(row)).toLocaleDateString("ar-EG"),
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
        applyBrandTextIfNeeded(td, value);
        tr.appendChild(td);
      });
      const actionCell = document.createElement("td");
      actionCell.className = "table-actions";
      const editButton = document.createElement("button");
      editButton.type = "button";
      editButton.className = "btn btn-secondary btn-compact";
      editButton.textContent = "تعديل";
      editButton.addEventListener("click", () => openSessionEditor(row));
      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "btn btn-danger btn-compact";
      deleteButton.textContent = "حذف";
      deleteButton.addEventListener("click", () => deleteSession(row));
      actionCell.append(editButton, deleteButton);
      tr.appendChild(actionCell);
      body.appendChild(tr);
    });
    if (!rows.length) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 11;
      td.className = "empty-cell";
      td.textContent = "لا توجد سجلات مطابقة";
      tr.appendChild(td);
      body.appendChild(tr);
    }
  }

  function applyLogFilters() {
    const filters = {
      studentId: document.getElementById("log-filter-student").value,
      method: document.getElementById("log-filter-method").value,
      listenerType: document.getElementById("log-filter-type").value,
      search: document.getElementById("log-filter-search").value,
      from: document.getElementById("log-filter-from").value,
      to: document.getElementById("log-filter-to").value,
    };
    state.filteredLogSessions = window.TaahudSessionLog.filterSessions(allLogSessions, filters);
    const totalPages = Math.max(1, Math.ceil(state.filteredLogSessions.length / state.logPageSize));
    state.logPage = Math.min(state.logPage, totalPages);
    const start = (state.logPage - 1) * state.logPageSize;
    renderLogTable(state.filteredLogSessions.slice(start, start + state.logPageSize));
    setText("log-results-summary", state.filteredLogSessions.length + " سجل");
    setText("log-page-label", "صفحة " + state.logPage + " من " + totalPages);
    document.getElementById("log-prev-btn").disabled = state.logPage <= 1;
    document.getElementById("log-next-btn").disabled = state.logPage >= totalPages;
  }

  async function refreshLog() {
    allLogSessions = await loadSessionsForLog();
    applyLogFilters();
  }

  async function populateLogStudentFilter() {
    const students = await loadAllStudents();
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
    ["log-filter-student", "log-filter-method", "log-filter-type", "log-filter-from", "log-filter-to"].forEach((id) => {
      document.getElementById(id).addEventListener("change", () => { state.logPage = 1; applyLogFilters(); });
    });
    document.getElementById("log-filter-search").addEventListener("input", () => { state.logPage = 1; applyLogFilters(); });
    document.getElementById("log-prev-btn").addEventListener("click", () => { state.logPage -= 1; applyLogFilters(); });
    document.getElementById("log-next-btn").addEventListener("click", () => { state.logPage += 1; applyLogFilters(); });
    document.getElementById("export-log-btn").addEventListener("click", () => {
      downloadCsv("taahud-sessions.csv",
        ["date","student","listener","pages","range","method","reciter_points","listener_points","satisfaction","notes"],
        state.filteredLogSessions.map((row) => [row.sessionDate,row.studentLabel,row.listenerLabel,row.pages,row.surahRange,row.method,row.pointsAwarded,row.listenerPointsAwarded,row.satisfaction,row.notes]));
    });
    document.getElementById("cancel-edit-btn").addEventListener("click", () => document.getElementById("session-edit-dialog").close());
    document.getElementById("session-edit-form").addEventListener("submit", saveSessionEdit);
  }

  function openSessionEditor(session) {
    document.getElementById("edit-session-id").value = session.id;
    document.getElementById("edit-session-date").value = session.sessionDate;
    document.getElementById("edit-pages").value = session.pages;
    document.getElementById("edit-method").value = session.method;
    document.getElementById("edit-satisfaction").value = session.satisfaction;
    document.getElementById("edit-reciter-points").value = session.pointsAwarded || 0;
    document.getElementById("edit-listener-points").value = session.listenerPointsAwarded || 0;
    document.getElementById("edit-surah-range").value = session.surahRange || "";
    document.getElementById("edit-notes").value = session.notes || "";
    document.getElementById("edit-reason").value = "";
    document.getElementById("session-edit-dialog").showModal();
  }

  async function saveSessionEdit(event) {
    event.preventDefault();
    const { error } = await state.client.rpc("admin_update_session", {
      target_session_id: document.getElementById("edit-session-id").value,
      p_pages: Number(document.getElementById("edit-pages").value),
      p_surah_range: document.getElementById("edit-surah-range").value || null,
      p_method: document.getElementById("edit-method").value,
      p_satisfaction: document.getElementById("edit-satisfaction").value,
      p_notes: document.getElementById("edit-notes").value || null,
      p_session_date: document.getElementById("edit-session-date").value,
      p_points_awarded: Number(document.getElementById("edit-reciter-points").value),
      p_listener_points_awarded: Number(document.getElementById("edit-listener-points").value),
      change_reason: document.getElementById("edit-reason").value,
    });
    if (error) return showToast("log-toast", "تعذر حفظ التعديل. راجع القيم والسبب", "error");
    document.getElementById("session-edit-dialog").close();
    showToast("log-toast", "تم تعديل الجلسة وتسجيل التغيير", "success");
    await refreshLog();
  }

  async function deleteSession(session) {
    const reason = window.prompt("اكتب سبب حذف جلسة " + session.studentLabel + ":");
    if (!reason) return;
    if (!window.confirm("تأكيد حذف الجلسة من كل الإحصائيات والسجلات؟")) return;
    const { error } = await state.client.rpc("admin_delete_session", { target_session_id: session.id, change_reason: reason });
    if (error) return showToast("log-toast", "تعذر حذف الجلسة", "error");
    showToast("log-toast", "تم حذف الجلسة مع الاحتفاظ بسجل المراجعة", "success");
    await refreshLog();
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
          sessionDate: s.sessionDate,
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
        new Date(sessionDisplayDate(row)).toLocaleDateString("ar-EG"),
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
        applyBrandTextIfNeeded(td, value);
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });
  }

  async function showStudentDetail(student) {
    currentDetailStudent = student;
    ["overview", "roster", "settings", "stats", "log"].forEach((name) => {
      document.getElementById("tab-" + name).hidden = true;
    });
    document.querySelectorAll(".tabs > .tab[data-tab]").forEach((button) => {
      const active = button.dataset.tab === "roster";
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    });
    document.getElementById("tab-student-detail").hidden = false;
    document.getElementById("student-detail-title").textContent = student.code + " — " + student.name;

    const sessions = await loadSessionsForLog();
    const stats = window.TaahudStats.aggregateStudentStats([student], sessions, "all", cairoDate())[0];
    document.getElementById("student-detail-sessions-recited").textContent = stats.sessionsRecited;
    document.getElementById("student-detail-pages-recited").textContent = stats.pagesRecited;
    document.getElementById("student-detail-sessions-listened").textContent = stats.sessionsListened;
    document.getElementById("student-detail-pages-listened").textContent = stats.pagesListened;
    document.getElementById("student-detail-points").textContent = stats.pointsEarned;

    renderStudentDetailTable(sessionsForStudent(student, sessions));
  }

  function hideStudentDetail() {
    currentDetailStudent = null;
    document.getElementById("tab-student-detail").hidden = true;
    document.getElementById("tab-roster").hidden = false;
    document.getElementById("tab-roster").focus({ preventScroll: true });
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
    wireRosterTools();
    wireRosterSearch();
    wireStudentDetail();
    wireAtRiskDialog();
    wireSettings();
    wireStatsControls();
    wireLogControls();
    window.addEventListener("beforeunload", stopAdminLiveUpdates);

    const {
      data: { session },
    } = await client.auth.getSession();

    if (session && session.user && session.user.email === ADMIN_EMAIL) {
      showDashboard();
      startAdminLiveUpdates();
      setAdminLoading(true);
      try {
        await refreshOverview();
      } finally {
        setAdminLoading(false);
      }
    } else {
      if (session) await client.auth.signOut();
      showLogin();
    }
  }

  document.addEventListener("DOMContentLoaded", init);

  return { state, switchTab, loadActiveStudents, refreshRoster };
})();
