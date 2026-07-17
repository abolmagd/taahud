"use strict";

(function () {
  const state = {
    client: null,
    code: "",
    password: "",
    student: null,
    students: [],
    sessions: [],
    statsPeriod: "day",
    recordsPeriod: "day",
  };

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

  function setButtonLoading(button, loading) {
    button.disabled = loading;
    button.dataset.originalText = button.dataset.originalText || button.textContent;
    button.textContent = loading ? "جارٍ الحفظ..." : button.dataset.originalText;
  }

  function friendlyError(error) {
    const message = (error && error.message) || "";
    if (message.includes("invalid_login")) return "الكود أو كلمة المرور غير صحيحة";
    if (message.includes("weak_password")) return "كلمة المرور يجب أن تكون ٦ أحرف على الأقل";
    if (message.includes("password_change_required")) return "يجب تغيير كلمة المرور أولًا";
    if (message.includes("invalid_listener")) return "كود السامع غير صحيح";
    if (message.includes("invalid_session_date")) return "اختر تاريخًا سابقًا صحيحًا";
    if (message.includes("Could not find the function") || message.includes("schema cache")) {
      return "تحديث قاعدة البيانات غير مكتمل، شغّل كود SQL الأخير";
    }
    return "حدث خطأ، يرجى المحاولة مرة أخرى";
  }

  function showView(name) {
    document.getElementById("student-login-card").hidden = name !== "login";
    document.getElementById("force-password-card").hidden = name !== "password";
    document.getElementById("student-dashboard").hidden = name !== "dashboard";
  }

  function sortStudentsByCode(students) {
    return students.slice().sort((a, b) => {
      const aNumber = Number(a.code);
      const bNumber = Number(b.code);
      if (Number.isFinite(aNumber) && Number.isFinite(bNumber)) return aNumber - bNumber;
      return String(a.code).localeCompare(String(b.code), "ar", { numeric: true });
    });
  }

  async function loadStudents() {
    const { data, error } = await state.client
      .from("students")
      .select("id, code")
      .eq("active", true)
      .order("code", { ascending: true });
    if (error) {
      console.error("[Ta'ahud] Failed to load students", error);
      return [];
    }
    return sortStudentsByCode(data || []);
  }

  function populateListenerSelect() {
    const selectEl = document.getElementById("listener-code");
    const currentValue = selectEl.value;
    const allowedValues = new Set(["__outside__", "__listening_only__"]);

    selectEl.innerHTML = "";
    const placeholderOption = document.createElement("option");
    placeholderOption.value = "";
    placeholderOption.textContent = state.students.length ? "اختر الكود..." : "لا توجد أكواد متاحة الآن";
    selectEl.appendChild(placeholderOption);

    [
      { value: "__outside__", label: "شخص آخر خارج تعاهُد", brandText: true },
      { value: "__listening_only__", label: "وِرد استماع" },
    ].forEach((option) => {
      const opt = document.createElement("option");
      opt.value = option.value;
      opt.textContent = option.label;
      if (option.brandText) opt.className = "brand-text";
      selectEl.appendChild(opt);
    });

    state.students.forEach((student) => {
      allowedValues.add(student.code);
      const opt = document.createElement("option");
      opt.value = student.code;
      opt.textContent = student.code;
      selectEl.appendChild(opt);
    });

    selectEl.value = allowedValues.has(currentValue) ? currentValue : "";
  }

  function deactivateListenerChips() {
    document.querySelectorAll(".code-search-quick-options .chip").forEach((btn) => {
      btn.classList.remove("active");
    });
  }

  function readListenerSelection(value) {
    if (value === "__outside__") return { listenerType: "outside", listenerCode: null };
    if (value === "__listening_only__") return { listenerType: "listening_only", listenerCode: null };
    return { listenerType: "student", listenerCode: value };
  }

  function localDateInputValue(value) {
    const date = value ? new Date(value) : new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return year + "-" + month + "-" + day;
  }

  function previousDate(value) {
    const date = value ? new Date(value) : new Date();
    date.setDate(date.getDate() - 1);
    return date;
  }

  function formatShortDate(value) {
    return new Date(value).toLocaleDateString("ar-EG", { day: "numeric", month: "short", year: "numeric" });
  }

  function roleLabel(role) {
    return role === "listener" ? "سامع" : "مُسمِّع";
  }

  const periodLabels = {
    day: "اليوم",
    week: "هذا الأسبوع",
    month: "هذا الشهر",
    all: "كل الوقت",
  };

  function filteredSessions(period) {
    return window.TaahudStudentDashboard.filterSessionsByPeriod(state.sessions, period, new Date());
  }

  function renderHistory() {
    const sessions = filteredSessions(state.recordsPeriod);
    const body = document.getElementById("student-history-body");
    body.innerHTML = "";
    document.getElementById("student-history-summary").textContent =
      sessions.length + " جلسة · " + periodLabels[state.recordsPeriod];

    if (!sessions.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 6;
      cell.className = "empty-cell";
      cell.textContent = "لا توجد جلسات مسجلة بعد";
      row.appendChild(cell);
      body.appendChild(row);
      return;
    }

    sessions.forEach((session) => {
      const row = document.createElement("tr");
      [
        { label: "التاريخ", value: formatShortDate(session.sessionDate || session.createdAt) },
        { label: "الدور", value: roleLabel(session.role) },
        { label: "الطرف الآخر", value: session.counterpart || "" },
        { label: "الصفحات", value: session.pages || 0 },
        { label: "الطريقة", value: session.method || "" },
        { label: "النقاط", value: session.points || 0 },
      ].forEach((entry) => {
        const cell = document.createElement("td");
        cell.dataset.label = entry.label;
        cell.textContent = entry.value;
        row.appendChild(cell);
      });
      body.appendChild(row);
    });
  }

  function renderStats() {
    const sessions = filteredSessions(state.statsPeriod);
    const totals = window.TaahudStudentDashboard.aggregateStudentSessions(sessions);

    document.getElementById("student-stats-period-label").textContent =
      "إحصائيات " + periodLabels[state.statsPeriod];
    document.getElementById("student-total-points").textContent = totals.totalPoints;
    document.getElementById("student-current-streak").textContent =
      window.TaahudStudentDashboard.currentStreak(state.sessions, new Date());
    document.getElementById("student-total-pages").textContent = totals.totalPages;
    document.getElementById("student-total-sessions").textContent = totals.totalSessions;
    document.getElementById("student-reciter-sessions").textContent = totals.reciterSessions;
    document.getElementById("student-reciter-pages").textContent = totals.reciterPages + " صفحة";
    document.getElementById("student-listener-sessions").textContent = totals.listenerSessions;
    document.getElementById("student-listener-pages").textContent = totals.listenerPages + " صفحة";
    document.getElementById("student-stats-empty").hidden = sessions.length !== 0;
  }

  function renderDashboard(profile) {
    state.student = profile.student;
    state.sessions = profile.sessions || [];

    document.getElementById("student-dashboard-title").textContent =
      state.student.code + " — " + state.student.name;
    renderStats();
    renderHistory();
  }

  async function authenticateStudent(code, password) {
    const { data, error } = await state.client.rpc("authenticate_student", {
      auth_code: code,
      auth_password: password,
    });
    if (error) throw error;
    return (data || [])[0] || null;
  }

  async function loadProfile() {
    const { data, error } = await state.client.rpc("get_student_profile", {
      auth_code: state.code,
      auth_password: state.password,
    });
    if (error) throw error;
    return data;
  }

  async function enterDashboard() {
    await enterDashboardWithProfile(await loadProfile());
  }

  async function enterDashboardWithProfile(profile) {
    state.students = await loadStudents();
    populateListenerSelect();
    renderDashboard(profile);
    showView("dashboard");
    showStudentView("checkin");
  }

  function showStudentView(name) {
    document.querySelectorAll("[data-student-view]").forEach((button) => {
      const active = button.dataset.studentView === name;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    });
    ["checkin", "stats", "records"].forEach((view) => {
      document.getElementById("student-view-" + view).hidden = view !== name;
    });
  }

  function wireStudentNavigation() {
    document.querySelectorAll("[data-student-view]").forEach((button) => {
      button.addEventListener("click", () => showStudentView(button.dataset.studentView));
    });
  }

  function syncPeriodFilter(containerId, period) {
    document.querySelectorAll("#" + containerId + " [data-period]").forEach((item) => {
      const active = item.dataset.period === period;
      item.classList.toggle("active", active);
      item.setAttribute("aria-pressed", String(active));
    });
  }

  function wirePeriodFilter(containerId, stateKey, render) {
    document.querySelectorAll("#" + containerId + " [data-period]").forEach((button) => {
      button.addEventListener("click", () => {
        state[stateKey] = button.dataset.period;
        syncPeriodFilter(containerId, state[stateKey]);
        render();
      });
    });
  }

  function wireLogin() {
    const form = document.getElementById("student-login-form");
    const button = document.getElementById("student-login-btn");
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const code = document.getElementById("login-code").value.trim();
      const password = document.getElementById("login-password").value;
      if (!code || !password) {
        showToast("login-toast", "اكتب الكود وكلمة المرور", "error");
        return;
      }

      setButtonLoading(button, true);
      try {
        const student = await authenticateStudent(code, password);
        if (!student) {
          showToast("login-toast", "الكود أو كلمة المرور غير صحيحة", "error");
          return;
        }
        state.code = code;
        state.password = password;
        state.student = student;
        if (student.must_change_password) {
          showView("password");
        } else {
          await enterDashboard();
        }
      } catch (error) {
        console.error("[Ta'ahud] Student login failed", error);
        showToast("login-toast", friendlyError(error), "error");
      } finally {
        setButtonLoading(button, false);
      }
    });
  }

  function wireForcedPasswordChange() {
    const form = document.getElementById("force-password-form");
    const button = document.getElementById("force-password-btn");
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const nextPassword = document.getElementById("new-student-password").value;
      const confirmPassword = document.getElementById("confirm-student-password").value;
      if (nextPassword.length < 6) {
        showToast("password-toast", "كلمة المرور يجب أن تكون ٦ أحرف على الأقل", "error");
        return;
      }
      if (nextPassword !== confirmPassword) {
        showToast("password-toast", "كلمتا المرور غير متطابقتين", "error");
        return;
      }

      setButtonLoading(button, true);
      try {
        const { data, error } = await state.client.rpc("complete_student_password_change", {
          auth_code: state.code,
          old_password: state.password,
          new_password: nextPassword,
        });
        if (error) throw error;
        state.password = nextPassword;
        await enterDashboardWithProfile(data);
      } catch (error) {
        console.error("[Ta'ahud] Password change failed", error);
        showToast("password-toast", friendlyError(error), "error");
      } finally {
        setButtonLoading(button, false);
      }
    });
  }

  function wireListenerChips() {
    document.querySelectorAll(".code-search-quick-options .chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        const value = chip.dataset.quickValue;
        document
          .querySelectorAll(".code-search-quick-options .chip")
          .forEach((btn) => btn.classList.toggle("active", btn === chip));
        document.getElementById("listener-code").value = value;
      });
    });
    document.getElementById("listener-code").addEventListener("change", deactivateListenerChips);
  }

  function wireSessionTiming() {
    const timing = document.getElementById("session-timing");
    const dateGroup = document.getElementById("session-date-group");
    const dateInput = document.getElementById("session-date");
    dateInput.max = localDateInputValue(previousDate(new Date()));

    timing.addEventListener("change", () => {
      const isPrevious = timing.value === "previous";
      dateGroup.hidden = !isPrevious;
      dateInput.required = isPrevious;
      if (isPrevious && !dateInput.value) {
        dateInput.value = localDateInputValue(previousDate(new Date()));
      }
    });
  }

  function wireCheckin() {
    const form = document.getElementById("checkin-form");
    const submitBtn = document.getElementById("submit-btn");
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const listenerValue = document.getElementById("listener-code").value;
      const pagesRaw = document.getElementById("pages").value;
      const pagesValue = Number(pagesRaw);
      const methodValue = document.getElementById("method").value;
      const satisfactionValue = document.getElementById("satisfaction").value;
      const sessionTiming = document.getElementById("session-timing").value;
      const sessionDate = document.getElementById("session-date").value;

      if (
        !listenerValue ||
        !pagesRaw ||
        !Number.isFinite(pagesValue) ||
        pagesValue < 0 ||
        !methodValue ||
        !satisfactionValue ||
        (sessionTiming === "previous" && !sessionDate)
      ) {
        showToast("toast", "يرجى تعبئة جميع الحقول المطلوبة", "error");
        return;
      }

      const listenerSelection = readListenerSelection(listenerValue);
      setButtonLoading(submitBtn, true);
      try {
        const { error } = await state.client.rpc("record_student_session", {
          auth_code: state.code,
          auth_password: state.password,
          p_listener_type: listenerSelection.listenerType,
          p_listener_code: listenerSelection.listenerCode,
          p_pages: pagesValue,
          p_surah_range: document.getElementById("surah-range").value || null,
          p_method: methodValue,
          p_satisfaction: satisfactionValue,
          p_notes: document.getElementById("notes").value || null,
          p_session_timing: sessionTiming,
          p_session_date: sessionTiming === "previous" ? sessionDate : null,
        });
        if (error) throw error;

        showToast("toast", "تم تسجيل الجلسة بنجاح", "success");
        form.reset();
        document.getElementById("session-date-group").hidden = true;
        document.getElementById("session-date").required = false;
        deactivateListenerChips();
        renderDashboard(await loadProfile());
      } catch (error) {
        console.error("[Ta'ahud] Failed to save session", error);
        if (((error && error.message) || "").includes("password_change_required")) {
          showView("password");
        }
        showToast("toast", friendlyError(error), "error");
      } finally {
        setButtonLoading(submitBtn, false);
      }
    });
  }

  function wireLogout() {
    document.getElementById("student-logout-btn").addEventListener("click", () => {
      state.code = "";
      state.password = "";
      state.student = null;
      state.sessions = [];
      state.statsPeriod = "day";
      state.recordsPeriod = "day";
      syncPeriodFilter("student-stats-filter", state.statsPeriod);
      syncPeriodFilter("student-records-filter", state.recordsPeriod);
      document.getElementById("student-login-form").reset();
      document.getElementById("force-password-form").reset();
      showView("login");
    });
  }

  async function init() {
    const client = getClient();
    if (!client) return;
    state.client = client;

    wireLogin();
    wireForcedPasswordChange();
    wireStudentNavigation();
    wirePeriodFilter("student-stats-filter", "statsPeriod", renderStats);
    wirePeriodFilter("student-records-filter", "recordsPeriod", renderHistory);
    wireListenerChips();
    wireSessionTiming();
    wireCheckin();
    wireLogout();
    showView("login");
  }

  document.addEventListener("DOMContentLoaded", init);
})();
