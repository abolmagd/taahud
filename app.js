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

  function populateSelect(select, options) {
    select.innerHTML = "";
    options.forEach((opt) => {
      const el = document.createElement("option");
      el.value = opt.value;
      el.textContent = opt.label;
      select.appendChild(el);
    });
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
    return data || [];
  }

  async function loadPointValue(client) {
    const { data, error } = await client
      .from("settings")
      .select("value")
      .eq("key", "point_value")
      .single();
    if (error || !data) {
      console.warn("[Ta'ahud] Failed to load point value, defaulting to 0", error);
      return 0;
    }
    return Number(data.value && data.value.value) || 0;
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

    const students = await loadStudents(client);
    const studentOptions = students.map((s) => ({ value: s.id, label: s.code + " — " + s.name }));

    populateSelect(studentSelect, [{ value: "", label: "اختر..." }].concat(studentOptions));
    populateSelect(
      listenerSelect,
      [
        { value: "", label: "اختر..." },
        { value: "__outside__", label: "شخص آخر خارج تعاهُد" },
        { value: "__listening_only__", label: "وِرد استماع" },
      ].concat(studentOptions)
    );

    const pointValue = await loadPointValue(client);

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
        showToast("من فضلك املأ كل الحقول المطلوبة", "error");
        return;
      }

      const listenerSelection = readListenerSelection(listenerSelect.value);
      const payload = {
        student_id: studentSelect.value,
        listener_type: listenerSelection.listenerType,
        listener_student_id: listenerSelection.listenerStudentId,
        pages: pagesValue,
        surah_range: document.getElementById("surah-range").value || null,
        method: methodValue,
        satisfaction: satisfactionValue,
        notes: document.getElementById("notes").value || null,
        points_awarded: window.TaahudPoints.computeSessionPoints({
          listenerType: listenerSelection.listenerType,
          pointValue,
        }),
      };

      const { error } = await client.from("sessions").insert(payload);
      submitBtn.disabled = false;

      if (error) {
        console.error("[Ta'ahud] Failed to save session", error);
        showToast("حصل خطأ أثناء التسجيل، حاول تاني", "error");
        return;
      }

      showToast("تم تسجيل ورد التسميع بنجاح", "success");
      form.reset();
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
