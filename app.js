"use strict";

(function () {
  const state = {
    client: null,
    accessToken: "",
    student: null,
    students: [],
    sessions: [],
    statsPeriod: "day",
    recordsPeriod: "day",
    pendingRequestId: null,
  };
  const STUDENT_TOKEN_KEY = "taahud_student_access_token";

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

  function setButtonLoading(button, loading) {
    button.disabled = loading;
    button.dataset.originalText = button.dataset.originalText || button.textContent;
    button.textContent = loading ? "جارٍ الحفظ..." : button.dataset.originalText;
  }

  function friendlyError(error) {
    const message = (error && error.message) || "";
    if (message.includes("invalid_login")) return "الكود أو كلمة المرور غير صحيحة";
    if (message.includes("weak_password")) return "كلمة المرور يجب أن تكون ٨ أحرف على الأقل";
    if (message.includes("invalid_student_session")) return "انتهت الجلسة، سجّل الدخول مرة أخرى";
    if (message.includes("self_listener_not_allowed")) return "لا يمكن اختيار كودك كسامع للجلسة";
    if (message.includes("invalid_pages")) return "عدد الصفحات يجب أن يكون من نصف صفحة إلى ١٠٠ صفحة";
    if (message.includes("invalid_method") || message.includes("invalid_satisfaction")) return "راجع تفاصيل الجلسة المختارة";
    if (message.includes("password_change_required")) return "يجب تغيير كلمة المرور أولًا";
    if (message.includes("invalid_listener")) return "كود السامع غير صحيح";
    if (message.includes("invalid_session_date")) return "اختر تاريخًا خلال آخر ٣ أيام";
    if (message.includes("Could not find the function") || message.includes("schema cache")) {
      return "تحديث قاعدة البيانات غير مكتمل، شغّل كود SQL الأخير";
    }
    return "حدث خطأ، يرجى المحاولة مرة أخرى";
  }

  function showView(name) {
    document.getElementById("public-app-header").hidden = name === "dashboard";
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
    const { data, error } = await state.client.rpc("list_active_student_codes", {
      access_token: state.accessToken,
    });
    if (error) {
      console.error("[Ta'ahud] Failed to load students", error);
      return [];
    }
    return sortStudentsByCode(data || []);
  }

  function populateListenerSelect() {
    const selectEl = document.getElementById("listener-code");
    const currentValue = selectEl.value;
    const allowedValues = new Set();

    selectEl.innerHTML = "";
    const placeholderOption = document.createElement("option");
    placeholderOption.value = "";
    placeholderOption.textContent = state.students.length ? "اختر الكود..." : "لا توجد أكواد متاحة الآن";
    selectEl.appendChild(placeholderOption);

    state.students.forEach((student) => {
      allowedValues.add(student.code);
      const opt = document.createElement("option");
      opt.value = student.code;
      opt.textContent = student.code;
      selectEl.appendChild(opt);
    });

    selectEl.value = allowedValues.has(currentValue) ? currentValue : "";
  }

  function readListenerSelection() {
    const selectedType = document.querySelector('input[name="listener-type"]:checked');
    const listenerType = selectedType ? selectedType.value : "";
    return {
      listenerType,
      listenerCode: listenerType === "student" ? document.getElementById("listener-code").value : null,
    };
  }

  function cairoDateParts(value) {
    const date = value ? new Date(value) : new Date();
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Africa/Cairo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  }

  function cairoDate() {
    const parts = cairoDateParts();
    return new Date(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
  }

  function localDateInputValue(value) {
    const date = value ? new Date(value) : cairoDate();
    return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
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
    return window.TaahudStudentDashboard.filterSessionsByPeriod(state.sessions, period, cairoDate());
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
      window.TaahudStudentDashboard.currentStreak(state.sessions, cairoDate());
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

  function profileIncludesSession(profile, sessionId) {
    if (!sessionId) return true;
    return (profile.sessions || []).some((session) => session.id === sessionId);
  }

  async function authenticateStudent(code, password) {
    const { data, error } = await state.client.rpc("student_login", {
      auth_code: code,
      auth_password: password,
    });
    if (error) throw error;
    return data || null;
  }

  async function loadProfile() {
    const { data, error } = await state.client.rpc("get_student_profile", {
      access_token: state.accessToken,
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
    ["checkin", "stats", "records", "account"].forEach((view) => {
      document.getElementById("student-view-" + view).hidden = view !== name;
    });
    const panel = document.getElementById("student-view-" + name);
    panel.setAttribute("tabindex", "-1");
    panel.focus({ preventScroll: true });
  }

  function wireStudentNavigation() {
    const tabs = Array.from(document.querySelectorAll("[data-student-view]"));
    tabs.forEach((button, index) => {
      button.addEventListener("click", () => showStudentView(button.dataset.studentView));
      button.addEventListener("keydown", (event) => {
        if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        event.preventDefault();
        const delta = event.key === 'ArrowLeft' ? 1 : -1;
        tabs[(index + delta + tabs.length) % tabs.length].focus();
      });
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
      const code = window.TaahudStudentDashboard.normalizeStudentCode(
        document.getElementById("login-code").value
      );
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
        state.accessToken = student.accessToken;
        state.student = student.student;
        sessionStorage.setItem(STUDENT_TOKEN_KEY, state.accessToken);
        document.getElementById("login-password").value = "";
        document.getElementById("login-code").value = code;
        if (student.mustChangePassword) {
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
      if (nextPassword.length < 8) {
        showToast("password-toast", "كلمة المرور يجب أن تكون ٨ أحرف على الأقل", "error");
        return;
      }
      if (nextPassword !== confirmPassword) {
        showToast("password-toast", "كلمتا المرور غير متطابقتين", "error");
        return;
      }

      setButtonLoading(button, true);
      try {
        const { error } = await state.client.rpc("student_change_password", {
          access_token: state.accessToken,
          new_password: nextPassword,
        });
        if (error) throw error;
        await enterDashboard();
      } catch (error) {
        console.error("[Ta'ahud] Password change failed", error);
        showToast("password-toast", friendlyError(error), "error");
      } finally {
        setButtonLoading(button, false);
      }
    });
  }

  function wireListenerTypeOptions() {
    document.querySelectorAll('input[name="listener-type"]').forEach((radio) => {
      radio.addEventListener("change", syncListenerFields);
    });
  }

  function syncListenerFields() {
    const selection = readListenerSelection();
    const studentListener = selection.listenerType === "student";
    const listeningOnly = selection.listenerType === "listening_only";
    const listenerCode = document.getElementById("listener-code");
    const method = document.getElementById("method");
    const satisfaction = document.getElementById("satisfaction");
    document.getElementById("listener-student-code-group").hidden = !studentListener;
    listenerCode.required = studentListener;
    if (!studentListener) listenerCode.value = "";
    document.getElementById("method-group").hidden = false;
    document.getElementById("satisfaction-group").hidden = listeningOnly;
    document.getElementById("method-label").textContent = listeningOnly ? "طريقة الاستماع؟" : "طريقة التسميع؟";
    method.required = true;
    satisfaction.required = !listeningOnly;
    if (listeningOnly) {
      satisfaction.value = "وردي كان ورد استماع";
    } else if (satisfaction.value === "وردي كان ورد استماع") {
      satisfaction.value = "";
    }
  }

  function wireSessionTiming() {
    const timing = document.getElementById("session-timing");
    const dateGroup = document.getElementById("session-date-group");
    const dateInput = document.getElementById("session-date");
    dateInput.max = localDateInputValue(previousDate(cairoDate()));
    const earliest = new Date(cairoDate());
    earliest.setDate(earliest.getDate() - 3);
    dateInput.min = localDateInputValue(earliest);

    timing.addEventListener("change", () => {
      const isPrevious = timing.value === "previous";
      dateGroup.hidden = !isPrevious;
      dateInput.required = isPrevious;
      if (isPrevious && !dateInput.value) {
        dateInput.value = localDateInputValue(previousDate(cairoDate()));
      }
    });
  }

  function wireCheckin() {
    const form = document.getElementById("checkin-form");
    const submitBtn = document.getElementById("submit-btn");
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const listenerSelection = readListenerSelection();
      const pagesRaw = document.getElementById("pages").value;
      const pagesValue = Number(pagesRaw);
      const methodValue = document.getElementById("method").value;
      const satisfactionValue = document.getElementById("satisfaction").value;
      const sessionTiming = document.getElementById("session-timing").value;
      const sessionDate = document.getElementById("session-date").value;

      if (
        !listenerSelection.listenerType ||
        (listenerSelection.listenerType === "student" && !listenerSelection.listenerCode) ||
        !pagesRaw ||
        !Number.isFinite(pagesValue) ||
        pagesValue <= 0 ||
        pagesValue > 100 ||
        !methodValue ||
        !satisfactionValue ||
        (sessionTiming === "previous" && !sessionDate)
      ) {
        showToast("toast", "يرجى تعبئة جميع الحقول المطلوبة", "error");
        return;
      }

      if (listenerSelection.listenerType === "student" && listenerSelection.listenerCode === state.student.code) {
        showToast("toast", "لا يمكن اختيار كودك كسامع للجلسة", "error");
        return;
      }
      state.pendingRequestId = state.pendingRequestId || crypto.randomUUID();
      setButtonLoading(submitBtn, true);
      try {
        const buildPayload = () => ({
          access_token: state.accessToken,
          p_client_request_id: state.pendingRequestId,
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

        let { data, error } = await state.client.rpc("record_student_session", buildPayload());
        if (error) throw error;
        let profile = await loadProfile();

        if (data && data.duplicate && !profileIncludesSession(profile, data.id)) {
          console.warn("[Ta'ahud] Duplicate request pointed to a hidden session; retrying with a fresh request id");
          state.pendingRequestId = crypto.randomUUID();
          const retry = await state.client.rpc("record_student_session", buildPayload());
          if (retry.error) throw retry.error;
          data = retry.data;
          profile = await loadProfile();
        }

        state.pendingRequestId = null;
        form.reset();
        document.getElementById("session-date-group").hidden = true;
        document.getElementById("session-date").required = false;
        syncListenerFields();
        renderDashboard(profile);
        const details = "تاريخ " + formatShortDate(data.sessionDate) + " · " + data.pointsAwarded + " نقطة";
        document.getElementById("session-receipt-details").textContent = details;
        const receipt = document.getElementById("session-receipt");
        receipt.hidden = false;
        receipt.focus();
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
    document.getElementById("student-logout-btn").addEventListener("click", async () => {
      if (state.accessToken) {
        await state.client.rpc("student_logout", { access_token: state.accessToken });
      }
      state.accessToken = "";
      sessionStorage.removeItem(STUDENT_TOKEN_KEY);
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

  function wireAccountPasswordChange() {
    const form = document.getElementById("account-password-form");
    const button = document.getElementById("account-password-btn");
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const password = document.getElementById("account-new-password").value;
      const confirmation = document.getElementById("account-confirm-password").value;
      if (password.length < 8 || password !== confirmation) {
        showToast("account-toast", password.length < 8 ? "كلمة المرور يجب أن تكون ٨ أحرف على الأقل" : "كلمتا المرور غير متطابقتين", "error");
        return;
      }
      setButtonLoading(button, true);
      const { error } = await state.client.rpc("student_change_password", {
        access_token: state.accessToken,
        new_password: password,
      });
      setButtonLoading(button, false);
      if (error) {
        showToast("account-toast", friendlyError(error), "error");
        return;
      }
      form.reset();
      showToast("account-toast", "تم تغيير كلمة المرور بنجاح", "success");
    });
  }

  function wireReceipt() {
    document.getElementById("open-records-btn").addEventListener("click", () => showStudentView("records"));
  }

  function wireInlineValidation() {
    const messages = {
      "login-code": "اكتب كود الطالب",
      "login-password": "اكتب كلمة المرور",
      "listener-code": "اختر السامع أو نوع الجلسة",
      pages: "أدخل عددًا من نصف صفحة إلى ١٠٠ صفحة",
      "session-date": "اختر تاريخًا خلال آخر ٣ أيام",
    };
    document.querySelectorAll("input, select, textarea").forEach((field) => {
      field.addEventListener("invalid", () => {
        const error = document.getElementById(field.id + "-error");
        if (!error) return;
        error.textContent = messages[field.id] || "راجع هذا الحقل";
        error.hidden = false;
        field.setAttribute("aria-invalid", "true");
      });
      field.addEventListener("input", () => {
        const error = document.getElementById(field.id + "-error");
        if (!error || !field.validity.valid) return;
        error.hidden = true;
        field.removeAttribute("aria-invalid");
      });
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
    wireListenerTypeOptions();
    wireSessionTiming();
    wireCheckin();
    wireLogout();
    wireAccountPasswordChange();
    wireReceipt();
    wireInlineValidation();

    state.accessToken = sessionStorage.getItem(STUDENT_TOKEN_KEY) || "";
    if (state.accessToken) {
      try {
        await enterDashboard();
        return;
      } catch (error) {
        console.warn("[Ta'ahud] Stored student session expired", error);
        sessionStorage.removeItem(STUDENT_TOKEN_KEY);
        state.accessToken = "";
      }
    }
    showView("login");
  }

  document.addEventListener("DOMContentLoaded", init);
})();
