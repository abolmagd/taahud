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

  // Searchable "type your code" field: types over an <input>, filters
  // `items` by code-prefix or name-substring, and shows a suggestion
  // list plus explicit valid/invalid feedback (per the design: the
  // student searches for their code rather than scrolling a long
  // dropdown, and is told clearly if what they typed doesn't exist).
  function setupCodeSearch({ inputEl, hiddenEl, suggestionsEl, feedbackEl, items, onClear }) {
    function showFeedback(message, kind) {
      if (!message) {
        feedbackEl.hidden = true;
        return;
      }
      feedbackEl.textContent = message;
      feedbackEl.className = "code-search-feedback code-search-feedback-" + kind;
      feedbackEl.hidden = false;
    }

    function hideSuggestions() {
      suggestionsEl.hidden = true;
      suggestionsEl.innerHTML = "";
    }

    function selectItem(item) {
      hiddenEl.value = item.value;
      inputEl.value = item.label;
      hideSuggestions();
      showFeedback("✓ " + item.label, "ok");
    }

    function renderSuggestions(matches) {
      suggestionsEl.innerHTML = "";
      matches.slice(0, 8).forEach((item) => {
        const el = document.createElement("div");
        el.className = "code-search-option";
        el.textContent = item.label;
        el.addEventListener("mousedown", (event) => {
          event.preventDefault(); // keep input focus so blur fires after selection
          selectItem(item);
        });
        suggestionsEl.appendChild(el);
      });
      suggestionsEl.hidden = matches.length === 0;
    }

    inputEl.addEventListener("input", () => {
      hiddenEl.value = "";
      const query = inputEl.value.trim().toLowerCase();
      if (!query) {
        hideSuggestions();
        showFeedback("", "ok");
        return;
      }
      const exact = items.find((item) => item.code.toLowerCase() === query);
      if (exact) {
        selectItem(exact);
        return;
      }
      const matches = items.filter(
        (item) => item.code.toLowerCase().startsWith(query) || item.name.toLowerCase().includes(query)
      );
      if (matches.length) {
        renderSuggestions(matches);
        showFeedback("", "ok");
      } else {
        hideSuggestions();
        showFeedback("لا يوجد كود أو اسم مطابق لما أدخلته", "error");
      }
    });

    inputEl.addEventListener("blur", () => {
      // Let a suggestion's mousedown run before we validate on blur.
      setTimeout(() => {
        hideSuggestions();
        if (hiddenEl.value) return;
        const query = inputEl.value.trim();
        if (!query) {
          showFeedback("", "ok");
          return;
        }
        showFeedback("لا يوجد كود أو اسم مطابق لما أدخلته", "error");
      }, 150);
    });

    // Re-focusing a field that already holds a resolved selection (a
    // matched student, or a quick-selected option) clears it instantly
    // so the student can search again without deleting the old text
    // by hand.
    inputEl.addEventListener("focus", () => {
      if (!hiddenEl.value) return;
      hiddenEl.value = "";
      inputEl.value = "";
      showFeedback("", "ok");
      if (onClear) onClear();
    });

    return {
      setQuickValue(value, label) {
        hiddenEl.value = value;
        inputEl.value = label;
        hideSuggestions();
        showFeedback("✓ " + label, "ok");
      },
    };
  }

  async function loadStudents(client) {
    const { data, error } = await client
      .from("students")
      .select("id, code, name")
      .eq("active", true)
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

    const studentHidden = document.getElementById("student-code");
    const listenerHidden = document.getElementById("listener-code");
    const form = document.getElementById("checkin-form");
    const submitBtn = document.getElementById("submit-btn");

    const students = await loadStudents(client);
    const items = students.map((s) => ({ value: s.id, code: s.code, name: s.name, label: s.code + " — " + s.name }));

    setupCodeSearch({
      inputEl: document.getElementById("student-code-input"),
      hiddenEl: studentHidden,
      suggestionsEl: document.getElementById("student-code-suggestions"),
      feedbackEl: document.getElementById("student-code-feedback"),
      items,
    });

    function deactivateListenerChips() {
      document.querySelectorAll(".code-search-quick-options .chip").forEach((btn) => {
        btn.classList.remove("active");
      });
    }

    const listenerSearch = setupCodeSearch({
      inputEl: document.getElementById("listener-code-input"),
      hiddenEl: listenerHidden,
      suggestionsEl: document.getElementById("listener-code-suggestions"),
      feedbackEl: document.getElementById("listener-code-feedback"),
      items,
      onClear: deactivateListenerChips,
    });

    const listenerQuickLabels = {
      __outside__: "شخص آخر خارج تعاهُد",
      __listening_only__: "وِرد استماع",
    };
    document.querySelectorAll(".code-search-quick-options .chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        const value = chip.dataset.quickValue;
        document
          .querySelectorAll(".code-search-quick-options .chip")
          .forEach((btn) => btn.classList.toggle("active", btn === chip));
        listenerSearch.setQuickValue(value, listenerQuickLabels[value]);
      });
    });

    const pointRules = await loadPointRules(client);

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      submitBtn.disabled = true;

      const pagesRaw = document.getElementById("pages").value;
      const pagesValue = Number(pagesRaw);
      const methodValue = document.getElementById("method").value;
      const satisfactionValue = document.getElementById("satisfaction").value;

      if (
        !studentHidden.value ||
        !listenerHidden.value ||
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

      const listenerSelection = readListenerSelection(listenerHidden.value);
      const reciterAlreadyLoggedToday = await hasStudentSessionToday(client, studentHidden.value, new Date());
      const listenerAlreadyLoggedToday =
        listenerSelection.listenerType === "student"
          ? listenerSelection.listenerStudentId === studentHidden.value
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
        student_id: studentHidden.value,
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

      const student = students.find((s) => s.id === payload.student_id);
      showToast("شكراً لتسجيلك يا " + (student ? student.name : "طالبنا") + "!", "success");
      form.reset();
      document.querySelectorAll(".code-search-feedback").forEach((el) => {
        el.hidden = true;
      });
      document.querySelectorAll(".code-search-suggestions").forEach((el) => {
        el.hidden = true;
        el.innerHTML = "";
      });
      deactivateListenerChips();
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
