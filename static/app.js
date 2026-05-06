const state = {
  locations: window.APP_CONFIG.locations,
  location: window.APP_CONFIG.locations[0],
  currentDate: new Date(),
  manager: false,
  forceReadOnly: !!window.APP_CONFIG.readOnly,
  publicMode: !!window.APP_CONFIG.publicMode,
  lastUpdated: null,
  managerPanelOpen: false,
  learnerTypes: {},
  presets: [],
};

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const SHIFT_CONFIG = [
  { key: "day", slots: 4, label: "D" },
  { key: "night", slots: 4, label: "N" },
  { key: "trainee", slots: 1, label: "Trainee" },
];

const els = {
  sessionPanel: document.getElementById("sessionPanel"),
  tabs: document.getElementById("locationTabs"),
  monthLabel: document.getElementById("monthLabel"),
  prevMonth: document.getElementById("prevMonth"),
  nextMonth: document.getElementById("nextMonth"),
  weekdayHeader: document.getElementById("weekdayHeader"),
  calendarBody: document.getElementById("calendarBody"),
  loginForm: document.getElementById("loginForm"),
  username: document.getElementById("username"),
  password: document.getElementById("password"),
  managerToggle: document.getElementById("managerToggle"),
  managerPopover: document.getElementById("managerPopover"),
  managerControls: document.getElementById("managerControls"),
  logoutButton: document.getElementById("logoutButton"),
  viewerBadge: document.getElementById("viewerBadge"),
  saveStatus: document.getElementById("saveStatus"),
  getPublishLink: document.getElementById("getPublishLink"),
  rotatePublishLink: document.getElementById("rotatePublishLink"),
  publishLinkField: document.getElementById("publishLinkField"),
  savePresetButton: document.getElementById("savePresetButton"),
  applyPresetButton: document.getElementById("applyPresetButton"),
  applyNext8Button: document.getElementById("applyNext8Button"),
  copyMonthButton: document.getElementById("copyMonthButton"),
  presetSelect: document.getElementById("presetSelect"),
};

function monthYear() {
  return {
    year: state.currentDate.getFullYear(),
    month: state.currentDate.getMonth() + 1,
  };
}

function canEdit() {
  return state.manager && !state.forceReadOnly;
}

function setStatus(message, isError = false) {
  els.saveStatus.textContent = message || "";
  els.saveStatus.classList.toggle("error", isError);
}

function toIsoDate(year, month, day) {
  const d = String(day).padStart(2, "0");
  const m = String(month).padStart(2, "0");
  return `${year}-${m}-${d}`;
}

function setManagerPanel(open) {
  state.managerPanelOpen = !!open;
  els.managerPopover.classList.toggle("hidden", !state.managerPanelOpen);
}

function renderTabs() {
  els.tabs.innerHTML = "";
  state.locations.forEach((location) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `location-tab ${location === state.location ? "active" : ""}`;
    button.textContent = location;
    button.addEventListener("click", () => {
      state.location = location;
      renderTabs();
      loadSchedule();
    });
    els.tabs.appendChild(button);
  });
}

function renderWeekdayHeader() {
  els.weekdayHeader.innerHTML = "";
  WEEKDAYS.forEach((name, index) => {
    const th = document.createElement("th");
    th.textContent = name;
    if (index === 0) {
      th.style.borderTop = "2px solid #2558cb";
    }
    els.weekdayHeader.appendChild(th);
  });
}

function renderMonthLabel() {
  const formatter = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
  els.monthLabel.textContent = formatter.format(state.currentDate);
}

function updateSessionUI() {
  const managerMode = canEdit();

  if (state.publicMode) {
    els.managerToggle.classList.add("hidden");
    els.managerPopover.classList.add("hidden");
    els.getPublishLink.classList.add("hidden");
    els.rotatePublishLink.classList.add("hidden");
    els.savePresetButton.classList.add("hidden");
    els.applyPresetButton.classList.add("hidden");
    els.applyNext8Button.classList.add("hidden");
    els.copyMonthButton.classList.add("hidden");
    els.presetSelect.classList.add("hidden");
    els.publishLinkField.classList.add("hidden");
    return;
  }

  els.managerToggle.classList.remove("hidden");
  els.viewerBadge.classList.toggle("hidden", managerMode);
  els.loginForm.classList.toggle("hidden", state.manager);
  els.managerControls.classList.toggle("hidden", !state.manager);
  els.getPublishLink.classList.toggle("hidden", !state.manager);
  els.rotatePublishLink.classList.toggle("hidden", !state.manager);
  els.savePresetButton.classList.toggle("hidden", !state.manager);
  els.applyPresetButton.classList.toggle("hidden", !state.manager);
  els.applyNext8Button.classList.toggle("hidden", !state.manager);
  els.copyMonthButton.classList.toggle("hidden", !state.manager);
  els.presetSelect.classList.toggle("hidden", !state.manager);
  els.publishLinkField.classList.toggle("hidden", !state.manager);
}

function renderPresetSelect() {
  els.presetSelect.innerHTML = "";
  if (!state.presets.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No presets yet";
    els.presetSelect.appendChild(opt);
    return;
  }
  state.presets.forEach((preset) => {
    const opt = document.createElement("option");
    opt.value = preset.name;
    opt.textContent = `${preset.name} (${preset.rotation_days} days)`;
    els.presetSelect.appendChild(opt);
  });
}

async function loadPresets() {
  const params = new URLSearchParams({ location: state.location });
  const response = await fetch(`/api/presets?${params.toString()}`);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Failed to load presets");
  }
  state.presets = data.presets || [];
  renderPresetSelect();
}

async function saveLearnerType(day, roleType, currentValue) {
  await saveShiftLine(day, "trainee", 1, currentValue || "", roleType);
  state.learnerTypes[String(day)] = roleType;
}

async function saveShiftLine(day, shift, slot, value, roleType = "") {
  const { year, month } = monthYear();
  const payload = {
    location: state.location,
    date: toIsoDate(year, month, day),
    shift,
    slot,
    staff_name: value.trim(),
  };

  if (shift === "trainee") {
    payload.role_type = roleType === "student" ? "student" : "trainee";
  }

  setStatus("Saving...");
  const response = await fetch("/api/schedule/update", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.error || "Unable to save");
  }

  state.lastUpdated = result.updated_at || state.lastUpdated;
  setStatus(`Saved ${payload.date} ${shift.toUpperCase()} slot ${slot}`);
}

function buildShiftLine(day, shift, slot, label, value, learnerType = "trainee") {
  const trimmedValue = (value || "").trim();

  if (!canEdit() && !trimmedValue) {
    return null;
  }

  const line = document.createElement("div");
  line.className = "shift-line";

  const labelEl = document.createElement("span");
  labelEl.className = "shift-label";
  labelEl.textContent = `${label} -`;
  line.appendChild(labelEl);

  if (canEdit()) {
    const input = document.createElement("input");
    input.type = "text";
    input.value = value || "";
    input.className = "shift-input";

    input.addEventListener("change", async () => {
      try {
        const activeLearnerType =
          shift === "trainee" ? (state.learnerTypes[String(day)] || learnerType || "trainee") : "";
        await saveShiftLine(day, shift, slot, input.value, activeLearnerType);
      } catch (err) {
        setStatus(err.message, true);
      }
    });

    line.appendChild(input);
  } else {
    const span = document.createElement("span");
    span.className = "shift-value";
    span.textContent = trimmedValue;
    line.appendChild(span);
  }

  if (canEdit() && shift === "trainee") {
    const selector = document.createElement("select");
    selector.className = "learner-type-select";
    selector.innerHTML = `
      <option value="trainee">Trainee</option>
      <option value="student">Student</option>
    `;
    selector.value = learnerType === "student" ? "student" : "trainee";
    selector.addEventListener("change", async () => {
      try {
        state.learnerTypes[String(day)] = selector.value;
        const input = line.querySelector("input.shift-input");
        await saveLearnerType(day, selector.value, input ? input.value : "");
        labelEl.textContent = `${selector.value === "student" ? "Student" : "Trainee"} -`;
      } catch (err) {
        setStatus(err.message, true);
      }
    });
    line.appendChild(selector);
  }

  return line;
}

function buildDayCell(day, dayData, showMonthName) {
  const td = document.createElement("td");
  td.className = "calendar-day";

  const content = document.createElement("div");
  content.className = "day-content";

  const top = document.createElement("div");
  top.className = "day-top";

  const number = document.createElement("div");
  number.className = "day-number";
  number.textContent = String(day);
  top.appendChild(number);

  if (showMonthName) {
    const monthName = document.createElement("div");
    monthName.className = "month-name";
    monthName.textContent = state.currentDate.toLocaleString(undefined, { month: "long" });
    top.appendChild(monthName);
  }

  content.appendChild(top);

  const list = document.createElement("div");
  list.className = "shift-list";

  SHIFT_CONFIG.forEach((shiftCfg) => {
    for (let i = 0; i < shiftCfg.slots; i += 1) {
      const shiftValues = dayData[shiftCfg.key] || [];
      const resolvedLearnerType = state.learnerTypes[String(day)] || "trainee";
      const resolvedLabel =
        shiftCfg.key === "trainee"
          ? resolvedLearnerType === "student"
            ? "Student"
            : "Trainee"
          : shiftCfg.label;
      const line = buildShiftLine(
        day,
        shiftCfg.key,
        i + 1,
        resolvedLabel,
        shiftValues[i] || "",
        resolvedLearnerType
      );
      if (line) {
        list.appendChild(line);
      }
    }
  });

  content.appendChild(list);
  td.appendChild(content);
  return td;
}

function buildEmptyCell() {
  const td = document.createElement("td");
  td.className = "calendar-day empty";
  return td;
}

function renderCalendar(days) {
  els.calendarBody.innerHTML = "";
  const { year, month } = monthYear();
  const daysInMonth = Object.keys(days).length;
  const firstWeekday = new Date(year, month - 1, 1).getDay();

  let dayPointer = 1;
  let weekIndex = 0;

  while (dayPointer <= daysInMonth) {
    const row = document.createElement("tr");

    for (let weekday = 0; weekday < 7; weekday += 1) {
      if ((weekIndex === 0 && weekday < firstWeekday) || dayPointer > daysInMonth) {
        row.appendChild(buildEmptyCell());
      } else {
        const cell = buildDayCell(dayPointer, days[String(dayPointer)] || {}, dayPointer === 1);
        row.appendChild(cell);
        dayPointer += 1;
      }
    }

    els.calendarBody.appendChild(row);
    weekIndex += 1;
  }
}

async function loadSchedule() {
  const { year, month } = monthYear();
  const params = new URLSearchParams({
    location: state.location,
    year: String(year),
    month: String(month),
  });

  const response = await fetch(`/api/schedule?${params.toString()}`);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "Failed to load schedule");
  }

  state.lastUpdated = data.last_updated;
  state.learnerTypes = data.learner_types || {};
  renderMonthLabel();
  renderCalendar(data.days);
  if (state.manager && !state.publicMode) {
    await loadPresets();
  }
}

async function saveCurrentPreset() {
  const name = window.prompt("Preset name:", "Default 8 Week Rotation");
  if (!name) {
    return;
  }
  const startDate = window.prompt("Rotation start date (YYYY-MM-DD):", "2026-03-15");
  if (!startDate) {
    return;
  }
  const endDate = window.prompt("Rotation end date (YYYY-MM-DD):", "2026-05-09");
  if (!endDate) {
    return;
  }

  const response = await fetch("/api/presets/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      location: state.location,
      name: name.trim(),
      start_date: startDate.trim(),
      end_date: endDate.trim(),
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Failed to save preset");
  }
  setStatus(`Saved preset: ${data.name}`);
  await loadPresets();
}

async function applySelectedPreset() {
  const presetName = els.presetSelect.value;
  if (!presetName) {
    throw new Error("Select a preset first");
  }
  const targetStart = window.prompt("Apply preset starting on (YYYY-MM-DD):");
  if (!targetStart) {
    return;
  }
  const weeksRaw = window.prompt("How many weeks to apply?", "8");
  if (!weeksRaw) {
    return;
  }

  const response = await fetch("/api/presets/apply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      location: state.location,
      name: presetName,
      target_start_date: targetStart.trim(),
      weeks: Number(weeksRaw),
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Failed to apply preset");
  }
  setStatus(`Applied ${presetName} for ${data.weeks} weeks`);
  await loadSchedule();
}

async function applyNext8Weeks() {
  const presetName = els.presetSelect.value;
  if (!presetName) {
    throw new Error("Select a preset first");
  }

  const response = await fetch("/api/presets/apply-next", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      location: state.location,
      name: presetName,
      weeks: 8,
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Failed to apply next 8 weeks");
  }

  setStatus(`Applied next 8 weeks from ${data.target_start_date}`);
  await loadSchedule();
}

async function copyMonthExport() {
  const { year, month } = monthYear();
  const params = new URLSearchParams({
    location: state.location,
    year: String(year),
    month: String(month),
  });
  const response = await fetch(`/api/schedule/export?${params.toString()}`);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Failed to export month");
  }
  await navigator.clipboard.writeText(data.text || "");
  setStatus("Month copied to clipboard");
}

async function refreshAuthStatus() {
  if (state.publicMode) {
    state.manager = false;
    updateSessionUI();
    return;
  }

  const response = await fetch("/api/auth-status");
  const data = await response.json();
  state.manager = !!data.is_manager;
  updateSessionUI();
}

async function doLogin(evt) {
  evt.preventDefault();
  const payload = {
    username: els.username.value.trim(),
    password: els.password.value,
  };

  try {
    const response = await fetch("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Login failed");
    }

    state.manager = true;
    els.password.value = "";
    updateSessionUI();
    setManagerPanel(false);
    await loadSchedule();
    setStatus("Manager login successful");
  } catch (err) {
    setStatus(err.message, true);
  }
}

async function doLogout() {
  await fetch("/logout", { method: "POST" });
  state.manager = false;
  updateSessionUI();
  await loadSchedule();
  setStatus("Logged out");
}

async function getPublishLink(rotate = false) {
  const endpoint = rotate ? "/api/publish-link/rotate" : "/api/publish-link";
  const method = rotate ? "POST" : "GET";

  const response = await fetch(endpoint, { method });
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "Unable to get public link");
  }

  els.publishLinkField.value = data.link;
  els.publishLinkField.select();
  setStatus(rotate ? "Public link rotated" : "Public link ready");
}

async function pollForUpdates() {
  const { year, month } = monthYear();
  const params = new URLSearchParams({
    location: state.location,
    year: String(year),
    month: String(month),
  });

  if (state.lastUpdated) {
    params.set("since", state.lastUpdated);
  }

  try {
    const response = await fetch(`/api/updates?${params.toString()}`);
    const data = await response.json();
    if (!response.ok) {
      return;
    }

    if (data.changed) {
      await loadSchedule();
      setStatus("Schedule refreshed with live updates");
    }
  } catch (err) {
    // Quiet background polling.
  }
}

function bindEvents() {
  els.prevMonth.addEventListener("click", async () => {
    state.currentDate = new Date(state.currentDate.getFullYear(), state.currentDate.getMonth() - 1, 1);
    await loadSchedule();
  });

  els.nextMonth.addEventListener("click", async () => {
    state.currentDate = new Date(state.currentDate.getFullYear(), state.currentDate.getMonth() + 1, 1);
    await loadSchedule();
  });

  els.loginForm.addEventListener("submit", doLogin);
  els.logoutButton.addEventListener("click", doLogout);

  els.managerToggle.addEventListener("click", () => {
    setManagerPanel(!state.managerPanelOpen);
  });

  document.addEventListener("click", (event) => {
    if (!state.managerPanelOpen || state.publicMode) {
      return;
    }

    if (!els.sessionPanel?.contains(event.target) && !els.managerPopover.contains(event.target)) {
      setManagerPanel(false);
    }
  });

  els.getPublishLink.addEventListener("click", async () => {
    try {
      await getPublishLink(false);
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  els.rotatePublishLink.addEventListener("click", async () => {
    try {
      await getPublishLink(true);
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  els.savePresetButton.addEventListener("click", async () => {
    try {
      await saveCurrentPreset();
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  els.applyPresetButton.addEventListener("click", async () => {
    try {
      await applySelectedPreset();
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  els.applyNext8Button.addEventListener("click", async () => {
    try {
      await applyNext8Weeks();
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  els.copyMonthButton.addEventListener("click", async () => {
    try {
      await copyMonthExport();
    } catch (err) {
      setStatus(err.message, true);
    }
  });
}

async function init() {
  renderTabs();
  renderWeekdayHeader();
  bindEvents();
  await refreshAuthStatus();
  await loadSchedule();
  window.setInterval(pollForUpdates, 8000);
}

init().catch((err) => {
  setStatus(err.message, true);
});




