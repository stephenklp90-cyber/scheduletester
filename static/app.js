function parseIsoDateLocal(iso) {
  const parts = String(iso || "").split("-");
  if (parts.length !== 3) return new Date();
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  return new Date(year, month - 1, day);
}
const state = {
  locations: window.APP_CONFIG.locations,
  location: window.APP_CONFIG.locations[0],
  windowStart: parseIsoDateLocal(window.APP_CONFIG.defaultWindowStart || "2026-05-10"),
  windowDays: Number(window.APP_CONFIG.windowDays || 56),
  manager: window.APP_CONFIG.role === "manager",
  role: window.APP_CONFIG.role || "employee",
  forceReadOnly: !!window.APP_CONFIG.readOnly,
  publicMode: !!window.APP_CONFIG.publicMode,
  lastUpdated: null,
  learnerTypes: {},
  presets: [],
  adminPanelOpen: false,
};

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const SHIFT_CONFIG = [
  { key: "day", slots: 4, label: "D" },
  { key: "night", slots: 4, label: "N" },
  { key: "trainee", slots: 1, label: "Trainee" },
];

const els = {
  tabs: document.getElementById("locationTabs"),
  windowLabel: document.getElementById("windowLabel"),
  prevWindow: document.getElementById("prevWindow"),
  nextWindow: document.getElementById("nextWindow"),
  weekdayHeader: document.getElementById("weekdayHeader"),
  calendarBody: document.getElementById("calendarBody"),
  logoutButton: document.getElementById("logoutButton"),
  viewerBadge: document.getElementById("viewerBadge"),
  managerBadge: document.getElementById("managerBadge"),
  adminToggleButton: document.getElementById("adminToggleButton"),
  adminPanel: document.getElementById("adminPanel"),
  employeeCredsForm: document.getElementById("employeeCredsForm"),
  employeeUsername: document.getElementById("employeeUsername"),
  employeePassword: document.getElementById("employeePassword"),
  saveStatus: document.getElementById("saveStatus"),
  getPublishLink: document.getElementById("getPublishLink"),
  rotatePublishLink: document.getElementById("rotatePublishLink"),
  publishLinkField: document.getElementById("publishLinkField"),
  savePresetButton: document.getElementById("savePresetButton"),
  applyPresetButton: document.getElementById("applyPresetButton"),
  applyNext8Button: document.getElementById("applyNext8Button"),
  undoButton: document.getElementById("undoButton"),
  clearMonthButton: document.getElementById("clearMonthButton"),
  copyMonthButton: document.getElementById("copyMonthButton"),
  presetSelect: document.getElementById("presetSelect"),
};

function canEdit() {
  return state.manager && !state.forceReadOnly;
}

function setStatus(message, isError = false) {
  els.saveStatus.textContent = message || "";
  els.saveStatus.classList.toggle("error", isError);
}

function toIsoDateValue(inputDate) {
  const year = inputDate.getFullYear();
  const month = String(inputDate.getMonth() + 1).padStart(2, "0");
  const day = String(inputDate.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function currentWindowStartIso() {
  return toIsoDateValue(state.windowStart);
}

function updateSessionUI() {
  const managerMode = canEdit();
  els.managerBadge.classList.toggle("hidden", !managerMode);
  els.viewerBadge.classList.toggle("hidden", managerMode);
  els.adminToggleButton.classList.toggle("hidden", !managerMode);
  els.adminPanel.classList.toggle("hidden", !managerMode || !state.adminPanelOpen);
  els.getPublishLink.classList.toggle("hidden", !managerMode);
  els.rotatePublishLink.classList.toggle("hidden", !managerMode);
  els.savePresetButton.classList.toggle("hidden", !managerMode);
  els.applyPresetButton.classList.toggle("hidden", !managerMode);
  els.applyNext8Button.classList.toggle("hidden", !managerMode);
  els.undoButton.classList.toggle("hidden", !managerMode);
  els.clearMonthButton.classList.toggle("hidden", !managerMode);
  els.copyMonthButton.classList.toggle("hidden", !managerMode);
  els.presetSelect.classList.toggle("hidden", !managerMode);
  els.publishLinkField.classList.toggle("hidden", !managerMode);
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
  WEEKDAYS.forEach((name) => {
    const th = document.createElement("th");
    th.textContent = name;
    els.weekdayHeader.appendChild(th);
  });
}

function renderWindowLabel() {
  const end = new Date(state.windowStart);
  end.setDate(end.getDate() + state.windowDays - 1);
  const fmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
  els.windowLabel.textContent = `${fmt.format(state.windowStart)} - ${fmt.format(end)}`;
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
  const response = await fetch(`/api/presets?${new URLSearchParams({ location: state.location }).toString()}`);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Failed to load presets");
  state.presets = data.presets || [];
  renderPresetSelect();
}

async function saveShiftLine(entryDateIso, shift, slot, value, roleType = "") {
  const payload = { location: state.location, date: entryDateIso, shift, slot, staff_name: value.trim() };
  if (shift === "trainee") payload.role_type = roleType === "student" ? "student" : "trainee";

  setStatus("Saving...");
  const response = await fetch("/api/schedule/update", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Unable to save");
  state.lastUpdated = result.updated_at || state.lastUpdated;
  setStatus(`Saved ${payload.date}`);
}

function buildShiftLine(entryDateIso, shift, slot, label, value, learnerType = "trainee") {
  const trimmedValue = (value || "").trim();
  if (!canEdit() && !trimmedValue) return null;

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
        const activeLearnerType = shift === "trainee" ? (state.learnerTypes[entryDateIso] || learnerType || "trainee") : "";
        await saveShiftLine(entryDateIso, shift, slot, input.value, activeLearnerType);
      } catch (err) {
        setStatus(err.message, true);
      }
    });
    line.appendChild(input);

    if (shift === "trainee") {
      const selector = document.createElement("select");
      selector.className = "learner-type-select";
      selector.innerHTML = `<option value="trainee">Trainee</option><option value="student">Student</option>`;
      selector.value = learnerType === "student" ? "student" : "trainee";
      selector.addEventListener("change", async () => {
        try {
          state.learnerTypes[entryDateIso] = selector.value;
          await saveShiftLine(entryDateIso, "trainee", 1, input.value, selector.value);
          labelEl.textContent = `${selector.value === "student" ? "Student" : "Trainee"} -`;
        } catch (err) {
          setStatus(err.message, true);
        }
      });
      line.appendChild(selector);
    }
  } else {
    const span = document.createElement("span");
    span.className = "shift-value";
    span.textContent = trimmedValue;
    line.appendChild(span);
  }

  return line;
}

function buildDayCell(entryDateIso, dayData, showMonthName) {
  const d = parseIsoDateLocal(entryDateIso);
  const dayNum = d.getDate();

  const td = document.createElement("td");
  td.className = "calendar-day";
  const content = document.createElement("div");
  content.className = "day-content";
  const top = document.createElement("div");
  top.className = "day-top";
  const number = document.createElement("div");
  number.className = "day-number";
  number.textContent = String(dayNum);
  top.appendChild(number);

  if (showMonthName) {
    const monthName = document.createElement("div");
    monthName.className = "month-name";
    monthName.textContent = d.toLocaleString(undefined, { month: "long" });
    top.appendChild(monthName);
  }

  content.appendChild(top);
  const list = document.createElement("div");
  list.className = "shift-list";

  SHIFT_CONFIG.forEach((cfg) => {
    for (let i = 0; i < cfg.slots; i += 1) {
      const vals = dayData[cfg.key] || [];
      const learnerType = state.learnerTypes[entryDateIso] || "trainee";
      const label = cfg.key === "trainee" ? (learnerType === "student" ? "Student" : "Trainee") : cfg.label;
      const line = buildShiftLine(entryDateIso, cfg.key, i + 1, label, vals[i] || "", learnerType);
      if (line) list.appendChild(line);
    }
  });

  content.appendChild(list);
  td.appendChild(content);
  return td;
}

function renderCalendar(days) {
  els.calendarBody.innerHTML = "";
  const keys = Object.keys(days).sort();
  for (let rowIndex = 0; rowIndex < 8; rowIndex += 1) {
    const row = document.createElement("tr");
    for (let col = 0; col < 7; col += 1) {
      const index = rowIndex * 7 + col;
      const key = keys[index];
      if (!key) {
        const empty = document.createElement("td");
        empty.className = "calendar-day empty";
        row.appendChild(empty);
      } else {
        const showMonthName = key.endsWith("-01") || index === 0;
        row.appendChild(buildDayCell(key, days[key] || {}, showMonthName));
      }
    }
    els.calendarBody.appendChild(row);
  }
}

async function loadSchedule() {
  const params = new URLSearchParams({
    location: state.location,
    start_date: currentWindowStartIso(),
  });
  const response = await fetch(`/api/schedule?${params.toString()}`);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Failed to load schedule");

  state.lastUpdated = data.last_updated;
  state.learnerTypes = data.learner_types || {};
  renderWindowLabel();
  renderCalendar(data.days || {});
  if (canEdit()) await loadPresets();
}

async function refreshAuthStatus() {
  const response = await fetch("/api/auth-status");
  const data = await response.json();
  if (!response.ok || !data.logged_in) {
    window.location.href = "/";
    return;
  }
  state.role = data.role;
  state.manager = data.role === "manager";
  state.forceReadOnly = !state.manager;
  updateSessionUI();
}

async function doLogout() {
  await fetch("/logout", { method: "POST" });
  window.location.href = "/";
}

async function getPublishLink(rotate = false) {
  const response = await fetch(rotate ? "/api/publish-link/rotate" : "/api/publish-link", { method: rotate ? "POST" : "GET" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Unable to get public link");
  els.publishLinkField.value = data.link;
  els.publishLinkField.select();
  setStatus(rotate ? "Public link rotated" : "Public link ready");
}

async function saveCurrentPreset() {
  const name = window.prompt("Preset name:", "Default 8 Week Rotation");
  if (!name) return;
  const startDate = window.prompt("Rotation start date (YYYY-MM-DD):", currentWindowStartIso());
  if (!startDate) return;
  const startObj = parseIsoDateLocal(startDate.trim());
  const endObj = new Date(startObj);
  endObj.setDate(endObj.getDate() + state.windowDays - 1);
  const endDateDefault = toIsoDateValue(endObj);
  const endDate = window.prompt("Rotation end date (YYYY-MM-DD):", endDateDefault);
  if (!endDate) return;

  const response = await fetch("/api/presets/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ location: state.location, name: name.trim(), start_date: startDate.trim(), end_date: endDate.trim() }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Failed to save preset");
  setStatus(`Saved preset: ${data.name}`);
  await loadPresets();
}

async function applySelectedPreset() {
  const presetName = els.presetSelect.value;
  if (!presetName) throw new Error("Select a preset first");
  const targetStart = window.prompt("Apply preset starting on (YYYY-MM-DD):");
  if (!targetStart) return;

  const response = await fetch("/api/presets/apply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ location: state.location, name: presetName, target_start_date: targetStart.trim(), weeks: 8 }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Failed to apply preset");
  setStatus(`Applied ${presetName} for ${data.weeks} weeks`);
  await loadSchedule();
}

async function applyNext8Weeks() {
  const presetName = els.presetSelect.value;
  if (!presetName) throw new Error("Select a preset first");

  const response = await fetch("/api/presets/apply-next", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ location: state.location, name: presetName, weeks: 8 }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Failed to apply next 8 weeks");
  setStatus(`Applied next 8 weeks from ${data.target_start_date}`);
  await loadSchedule();
}

async function undoLastChange() {
  const response = await fetch("/api/schedule/undo-last", { method: "POST" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Failed to undo");
  setStatus(`Undid last change (${data.changed_rows} rows)`);
  await loadSchedule();
}

async function clearCurrentWindow() {
  const start = currentWindowStartIso();
  const end = toIsoDateValue(new Date(state.windowStart.getTime() + (state.windowDays - 1) * 86400000));
  if (!window.confirm(`Clear entries for ${state.location} from ${start} to ${end}?`)) return;

  const response = await fetch("/api/schedule/clear-month", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ location: state.location, start_date: start, window_days: state.windowDays }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Failed to clear window month");
  setStatus(`Cleared ${data.deleted_rows} entries in current 8-week window`);
  await loadSchedule();
}

async function copyWindowExport() {
  const response = await fetch(`/api/schedule/export?${new URLSearchParams({ location: state.location, start_date: currentWindowStartIso() }).toString()}`);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Failed to export window");
  await navigator.clipboard.writeText(data.text || "");
  setStatus("8-week schedule copied to clipboard");
}

async function updateEmployeeCredentials(evt) {
  evt.preventDefault();
  const username = els.employeeUsername.value.trim();
  const password = els.employeePassword.value;
  if (!username) {
    setStatus("Employee username is required", true);
    return;
  }

  const response = await fetch("/api/admin/employee-credentials", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Unable to update employee credentials");
  els.employeePassword.value = "";
  setStatus("Employee login updated");
}

async function pollForUpdates() {
  const params = new URLSearchParams({ location: state.location, start_date: currentWindowStartIso() });
  if (state.lastUpdated) params.set("since", state.lastUpdated);
  try {
    const response = await fetch(`/api/updates?${params.toString()}`);
    const data = await response.json();
    if (response.ok && data.changed) {
      await loadSchedule();
      setStatus("Schedule refreshed with live updates");
    }
  } catch (_err) {
  }
}

function bindEvents() {
  els.prevWindow.addEventListener("click", async () => {
    state.windowStart = new Date(state.windowStart.getTime() - state.windowDays * 86400000);
    await loadSchedule();
  });

  els.nextWindow.addEventListener("click", async () => {
    state.windowStart = new Date(state.windowStart.getTime() + state.windowDays * 86400000);
    await loadSchedule();
  });

  els.logoutButton.addEventListener("click", doLogout);
  els.adminToggleButton.addEventListener("click", () => {
    state.adminPanelOpen = !state.adminPanelOpen;
    updateSessionUI();
  });

  if (els.employeeCredsForm) {
    els.employeeCredsForm.addEventListener("submit", async (evt) => {
      try {
        await updateEmployeeCredentials(evt);
      } catch (err) {
        setStatus(err.message, true);
      }
    });
  }

  els.getPublishLink.addEventListener("click", async () => {
    try { await getPublishLink(false); } catch (err) { setStatus(err.message, true); }
  });
  els.rotatePublishLink.addEventListener("click", async () => {
    try { await getPublishLink(true); } catch (err) { setStatus(err.message, true); }
  });
  els.savePresetButton.addEventListener("click", async () => {
    try { await saveCurrentPreset(); } catch (err) { setStatus(err.message, true); }
  });
  els.applyPresetButton.addEventListener("click", async () => {
    try { await applySelectedPreset(); } catch (err) { setStatus(err.message, true); }
  });
  els.applyNext8Button.addEventListener("click", async () => {
    try { await applyNext8Weeks(); } catch (err) { setStatus(err.message, true); }
  });
  els.undoButton.addEventListener("click", async () => {
    try { await undoLastChange(); } catch (err) { setStatus(err.message, true); }
  });
  els.clearMonthButton.addEventListener("click", async () => {
    try { await clearCurrentWindow(); } catch (err) { setStatus(err.message, true); }
  });
  els.copyMonthButton.addEventListener("click", async () => {
    try { await copyWindowExport(); } catch (err) { setStatus(err.message, true); }
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

init().catch((err) => setStatus(err.message, true));

