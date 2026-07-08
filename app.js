"use strict";

(function () {
  function getClient() {
    if (!window._supabase) {
      console.error("[Ta'ahud] Supabase client not initialized — check supabase-config.js");
      return null;
    }
    return window._supabase;
  }

  function showToast(message, kind) {
    const toast = document.getElementById("toast");
    toast.textContent = message;
    toast.className = "toast toast-" + (kind || "success");
    toast.hidden = false;
    setTimeout(() => {
      toast.hidden = true;
    }, 4000);
  }

  async function loadStudents(client) {
    const { data, error } = await client
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

  function populateCodeSelect(selectEl, students, placeholder, selectedValue, extraOptions) {
    const allowedValues = new Set(students.map((student) => student.id));
    (extraOptions || []).forEach((option) => allowedValues.add(option.value));
    const nextValue = allowedValues.has(selectedValue) ? selectedValue : "";

    selectEl.innerHTML = "";
    const placeholderOption = document.createElement("option");
    placeholderOption.value = "";
    placeholderOption.textContent = students.length ? placeholder : "لا توجد أكواد متاحة الآن";
    selectEl.appendChild(placeholderOption);

    (extraOptions || []).forEach((option) => {
      const opt = document.createElement("option");
      opt.value = option.value;
      opt.textContent = option.label;
      selectEl.appendChild(opt);
    });

    students.forEach((student) => {
      const opt = document.createElement("option");
      opt.value = student.id;
      opt.textContent = student.code;
      selectEl.appendChild(opt);
    });

    selectEl.value = nextValue;
  }

  function sortStudentsByCode(students) {
    return students.slice().sort((a, b) => {
      const aNumber = Number(a.code);
      const bNumber = Number(b.code);
      if (Number.isFinite(aNumber) && Number.isFinite(bNumber)) return aNumber - bNumber;
      return String(a.code).localeCompare(String(b.code), "ar", { numeric: true });
    });
  }

  async function loadPointRules(client) {
    const { data, error } = await client
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

  function localDayBounds(referenceDate) {
    const ref = referenceDate || new Date();
    const start = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate());
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return { start, end };
  }

  async function hasStudentSessionToday(client, studentId, referenceDate) {
    const { start, end } = localDayBounds(referenceDate);
    const { data, error } = await client.rpc("has_student_session_between", {
      checked_student_id: studentId,
      range_start: start.toISOString(),
      range_end: end.toISOString(),
    });
    if (error) {
      console.warn("[Ta'ahud] Failed to check daily streak status", error);
      return false;
    }
    return Boolean(data);
  }

  function readListenerSelection(value) {
    if (value === "__outside__") return { listenerType: "outside", listenerStudentId: null };
    if (value === "__listening_only__") return { listenerType: "listening_only", listenerStudentId: null };
    return { listenerType: "student", listenerStudentId: value };
  }

  async function init() {
    const client = getClient();
    if (!client) return;

    const studentSelect = document.getElementById("student-code");
    const listenerSelect = document.getElementById("listener-code");
    const form = document.getElementById("checkin-form");
    const submitBtn = document.getElementById("submit-btn");
    const listenerQuickOptions = [
      { value: "__outside__", label: "شخص آخر خارج تعاهُد" },
      { value: "__listening_only__", label: "وِرد استماع" },
    ];

    let students = [];
    let refreshInFlight = null;

    function deactivateListenerChips() {
      document.querySelectorAll(".code-search-quick-options .chip").forEach((btn) => {
        btn.classList.remove("active");
      });
    }

    async function refreshCodeLists() {
      if (refreshInFlight) return refreshInFlight;
      refreshInFlight = loadStudents(client)
        .then((nextStudents) => {
          students = nextStudents;
          populateCodeSelect(studentSelect, students, "اختر كودك...", studentSelect.value);
          populateCodeSelect(
            listenerSelect,
            students,
            "اختر الكود...",
            listenerSelect.value,
            listenerQuickOptions
          );
        })
        .finally(() => {
          refreshInFlight = null;
        });
      return refreshInFlight;
    }

    await refreshCodeLists();

    document.querySelectorAll(".code-search-quick-options .chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        const value = chip.dataset.quickValue;
        document
          .querySelectorAll(".code-search-quick-options .chip")
          .forEach((btn) => btn.classList.toggle("active", btn === chip));
        listenerSelect.value = value;
      });
    });

    listenerSelect.addEventListener("change", deactivateListenerChips);
    window.addEventListener("focus", refreshCodeLists);
    window.setInterval(refreshCodeLists, 30000);

    if (typeof client.channel === "function") {
      client
        .channel("student-code-list")
        .on("postgres_changes", { event: "*", schema: "public", table: "students" }, refreshCodeLists)
        .subscribe();
    }

    const pointRules = await loadPointRules(client);

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      submitBtn.disabled = true;

      const pagesRaw = document.getElementById("pages").value;
      const pagesValue = Number(pagesRaw);
      const methodValue = document.getElementById("method").value;
      const satisfactionValue = document.getElementById("satisfaction").value;

      if (
        !studentSelect.value ||
        !listenerSelect.value ||
        !pagesRaw ||
        !Number.isFinite(pagesValue) ||
        pagesValue < 0 ||
        !methodValue ||
        !satisfactionValue
      ) {
        submitBtn.disabled = false;
        showToast("يرجى تعبئة جميع الحقول المطلوبة", "error");
        return;
      }

      const listenerSelection = readListenerSelection(listenerSelect.value);
      const reciterAlreadyLoggedToday = await hasStudentSessionToday(client, studentSelect.value, new Date());
      const listenerAlreadyLoggedToday =
        listenerSelection.listenerType === "student"
          ? listenerSelection.listenerStudentId === studentSelect.value
            ? reciterAlreadyLoggedToday
            : await hasStudentSessionToday(client, listenerSelection.listenerStudentId, new Date())
          : false;
      const sessionPoints = window.TaahudPoints.computeSessionPoints({
        listenerType: listenerSelection.listenerType,
        pages: pagesValue,
        pointRules,
        awardReciterDailyCheckin: !reciterAlreadyLoggedToday,
        awardListenerDailyCheckin:
          listenerSelection.listenerType === "student" && !listenerAlreadyLoggedToday,
      });
      const payload = {
        student_id: studentSelect.value,
        listener_type: listenerSelection.listenerType,
        listener_student_id: listenerSelection.listenerStudentId,
        pages: pagesValue,
        surah_range: document.getElementById("surah-range").value || null,
        method: methodValue,
        satisfaction: satisfactionValue,
        notes: document.getElementById("notes").value || null,
        points_awarded: sessionPoints.reciterPoints,
        listener_points_awarded: sessionPoints.listenerPoints,
      };

      const { error } = await client.from("sessions").insert(payload);
      submitBtn.disabled = false;

      if (error) {
        console.error("[Ta'ahud] Failed to save session", error);
        showToast("حدث خطأ أثناء التسجيل، يرجى المحاولة مرة أخرى", "error");
        return;
      }

      showToast("تم تسجيل الجلسة بنجاح", "success");
      form.reset();
      deactivateListenerChips();
      await refreshCodeLists();
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
