const state = {
  locations: window.APP_CONFIG.locations,
  location: window.APP_CONFIG.locations[0],
  currentDate: new Date(),
  manager: false,
  forceReadOnly: !!window.APP_CONFIG.readOnly,
  publicMode: !!window.APP_CONFIG.publicMode,
  lastUpdated: null,
};

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const els = {
  tabs: document.getElementById("locationTabs"),
  monthLabel: document.getElementById("monthLabel"),
  prevMonth: document.getElementById("prevMonth"),
  nextMonth: document.getElementById("nextMonth"),
  weekdayHeader: document.getElementById("weekdayHeader"),
  calendarBody: document.getElementById("calendarBody"),
  loginForm: document.getElementById("loginForm"),
  username: document.getElementById("username"),
  password: document.getElementById("password"),
  managerControls: document.getElementById("managerControls"),
  logoutButton: document.getElementById("logoutButton"),
  viewerBadge: document.getElementById("viewerBadge"),
  saveStatus: document.getElementById("saveStatus"),
  getPublishLink: document.getElementById("getPublishLink"),
  rotatePublishLink: document.getElementById("rotatePublishLink"),
  publishLinkField: document.getElementById("publishLinkField"),
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
    els.loginForm.classList.add("hidden");
    els.managerControls.classList.add("hidden");
    els.getPublishLink.classList.add("hidden");
    els.rotatePublishLink.classList.add("hidden");
    els.publishLinkField.classList.add("hidden");
    return;
  }

  els.viewerBadge.classList.toggle("hidden", managerMode);
  els.loginForm.classList.toggle("hidden", state.manager);
  els.managerControls.classList.toggle("hidden", !state.manager);
  els.getPublishLink.classList.toggle("hidden", !state.manager);
  els.rotatePublishLink.classList.toggle("hidden", !state.manager);
  els.publishLinkField.classList.toggle("hidden", !state.manager);
}

async function saveShiftLine(day, shift, slot, value) {
  const { year, month } = monthYear();
  const payload = {
    location: state.location,
    date: toIsoDate(year, month, day),
    shift,
    slot,
    staff_name: value.trim(),
  };

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

function buildShiftLine(day, shift, slot, value) {
  const line = document.createElement("div");
  line.className = "shift-line";

  const label = document.createElement("span");
  label.className = "shift-label";
  label.textContent = `${shift === "day" ? "D" : "N"} -`;
  line.appendChild(label);

  if (canEdit()) {
    const input = document.createElement("input");
    input.type = "text";
    input.value = value || "";
    input.className = "shift-input";
    input.placeholder = "";

    input.addEventListener("change", async () => {
      try {
        await saveShiftLine(day, shift, slot, input.value);
      } catch (err) {
        setStatus(err.message, true);
      }
    });

    line.appendChild(input);
  } else {
    const span = document.createElement("span");
    span.className = "shift-value";
    span.textContent = value || "";
    line.appendChild(span);
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

  for (let i = 0; i < 3; i += 1) {
    list.appendChild(buildShiftLine(day, "day", i + 1, dayData.day[i] || ""));
  }
  for (let i = 0; i < 3; i += 1) {
    list.appendChild(buildShiftLine(day, "night", i + 1, dayData.night[i] || ""));
  }

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
        const cell = buildDayCell(dayPointer, days[String(dayPointer)], dayPointer === 1);
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
  renderMonthLabel();
  renderCalendar(data.days);
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
