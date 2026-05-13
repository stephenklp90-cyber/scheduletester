import argparse
import calendar
import json
import os
import secrets
import sqlite3
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from flask import Flask, jsonify, render_template, request, session, url_for
from werkzeug.security import check_password_hash, generate_password_hash

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("SCHEDULE_DB_PATH", str(BASE_DIR / "schedule.db"))).resolve()
DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = int(os.environ.get("PORT", "5000"))
PUBLIC_BASE_URL = os.environ.get("PUBLIC_BASE_URL", "").strip()

LOCATIONS = ["MRC", "SPC", "SPC2", "FN2", "WSH", "Adult"]
SHIFT_SLOT_LIMITS = {
    "day": 4,
    "night": 4,
    "trainee": 1,
}
SHIFTS = list(SHIFT_SLOT_LIMITS.keys())
DEFAULT_ROTATION_START = date(2026, 3, 15)
DEFAULT_ROTATION_END = date(2026, 5, 9)
WINDOW_DAYS = 56
DEFAULT_VIEW_START = date(2026, 5, 10)

app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("SCHEDULE_SECRET_KEY", secrets.token_hex(32))


def get_db_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def get_setting(conn: sqlite3.Connection, key: str, default: str | None = None) -> str | None:
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


def set_setting(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        """
        INSERT INTO settings (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
        """,
        (key, value),
    )


def parse_year_month(year_raw: str | None, month_raw: str | None) -> tuple[int, int]:
    today = date.today()
    year = int(year_raw) if year_raw else today.year
    month = int(month_raw) if month_raw else today.month
    if month < 1 or month > 12:
        raise ValueError("month must be between 1 and 12")
    if year < 2000 or year > 2100:
        raise ValueError("year out of range")
    return year, month


def empty_month_payload(year: int, month: int) -> dict[str, dict[str, list[str]]]:
    days_in_month = calendar.monthrange(year, month)[1]
    payload: dict[str, dict[str, list[str]]] = {}

    for day in range(1, days_in_month + 1):
        payload[str(day)] = {
            shift: ["" for _ in range(slot_limit)]
            for shift, slot_limit in SHIFT_SLOT_LIMITS.items()
        }

    return payload


def empty_learner_type_payload(year: int, month: int) -> dict[str, str]:
    days_in_month = calendar.monthrange(year, month)[1]
    return {str(day): "trainee" for day in range(1, days_in_month + 1)}


def is_manager_logged_in() -> bool:
    return session.get("role") == "manager"


def base_url() -> str:
    if PUBLIC_BASE_URL:
        return PUBLIC_BASE_URL.rstrip("/")
    return request.url_root.rstrip("/")


def load_entries_for_range(conn: sqlite3.Connection, location: str, start_date: date, end_date: date) -> list[sqlite3.Row]:
    return conn.execute(
        """
        SELECT entry_date, shift, slot, staff_name, role_type
        FROM schedule_entries
        WHERE location = ? AND entry_date BETWEEN ? AND ?
        ORDER BY entry_date, shift, slot
        """,
        (location, start_date.isoformat(), end_date.isoformat()),
    ).fetchall()


def get_existing_entry(
    conn: sqlite3.Connection, location: str, entry_date: str, shift: str, slot: int
) -> sqlite3.Row | None:
    return conn.execute(
        """
        SELECT staff_name, role_type
        FROM schedule_entries
        WHERE location = ? AND entry_date = ? AND shift = ? AND slot = ?
        """,
        (location, entry_date, shift, slot),
    ).fetchone()


def create_operation(conn: sqlite3.Connection, actor_role: str) -> int:
    cursor = conn.execute(
        "INSERT INTO change_operations (actor_role, created_at) VALUES (?, ?)",
        (actor_role, now_iso()),
    )
    return int(cursor.lastrowid)


def log_change(
    conn: sqlite3.Connection,
    operation_id: int,
    location: str,
    entry_date: str,
    shift: str,
    slot: int,
    prev_staff: str | None,
    prev_role: str | None,
    new_staff: str | None,
    new_role: str | None,
) -> None:
    conn.execute(
        """
        INSERT INTO change_entries (
            operation_id, location, entry_date, shift, slot,
            prev_staff_name, prev_role_type, new_staff_name, new_role_type
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (operation_id, location, entry_date, shift, slot, prev_staff, prev_role, new_staff, new_role),
    )


def apply_entry_with_log(
    conn: sqlite3.Connection,
    operation_id: int,
    location: str,
    entry_date: str,
    shift: str,
    slot: int,
    new_staff: str,
    new_role: str,
    updated_at: str,
) -> None:
    prev = get_existing_entry(conn, location, entry_date, shift, slot)
    prev_staff = prev["staff_name"] if prev else None
    prev_role = prev["role_type"] if prev else None

    if prev_staff == new_staff and (prev_role or "") == (new_role or ""):
        return

    log_change(conn, operation_id, location, entry_date, shift, slot, prev_staff, prev_role, new_staff, new_role)
    conn.execute(
        """
        INSERT INTO schedule_entries (location, entry_date, shift, slot, staff_name, role_type, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(location, entry_date, shift, slot)
        DO UPDATE SET
            staff_name = excluded.staff_name,
            role_type = excluded.role_type,
            updated_at = excluded.updated_at
        """,
        (location, entry_date, shift, slot, new_staff, new_role, updated_at),
    )


def apply_preset_pattern(
    conn: sqlite3.Connection,
    operation_id: int,
    location: str,
    pattern: dict,
    rotation_days: int,
    target_start: date,
    weeks: int,
) -> int:
    total_days = weeks * 7
    updated_at = now_iso()

    for day_offset in range(total_days):
        target_day = target_start + timedelta(days=day_offset)
        source_key = str(day_offset % rotation_days)
        source = pattern.get(source_key, {})

        for shift in SHIFTS:
            slot_limit = SHIFT_SLOT_LIMITS[shift]
            slot_map = source.get(shift, {})
            for slot in range(1, slot_limit + 1):
                staff_name = str(slot_map.get(str(slot), "")).strip()
                role_type = ""
                if shift == "trainee":
                    role_map = source.get("role_type", {})
                    role_type = "student" if str(role_map.get("1", "trainee")).lower() == "student" else "trainee"
                apply_entry_with_log(
                    conn,
                    operation_id,
                    location,
                    target_day.isoformat(),
                    shift,
                    slot,
                    staff_name,
                    role_type,
                    updated_at,
                )

    return total_days


def init_db() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)

    with get_db_connection() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS schedule_entries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                location TEXT NOT NULL,
                entry_date TEXT NOT NULL,
                shift TEXT NOT NULL,
                slot INTEGER NOT NULL,
                staff_name TEXT NOT NULL,
                role_type TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL,
                UNIQUE(location, entry_date, shift, slot)
            )
            """
        )

        columns = conn.execute("PRAGMA table_info(schedule_entries)").fetchall()
        existing_column_names = {column["name"] for column in columns}
        if "role_type" not in existing_column_names:
            conn.execute("ALTER TABLE schedule_entries ADD COLUMN role_type TEXT NOT NULL DEFAULT ''")

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS schedule_presets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                location TEXT NOT NULL,
                rotation_days INTEGER NOT NULL,
                payload_json TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(name, location)
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS change_operations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                actor_role TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS change_entries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                operation_id INTEGER NOT NULL,
                location TEXT NOT NULL,
                entry_date TEXT NOT NULL,
                shift TEXT NOT NULL,
                slot INTEGER NOT NULL,
                prev_staff_name TEXT,
                prev_role_type TEXT,
                new_staff_name TEXT,
                new_role_type TEXT,
                FOREIGN KEY(operation_id) REFERENCES change_operations(id)
            )
            """
        )

        if get_setting(conn, "manager_username") is None:
            set_setting(conn, "manager_username", "manager")

        if get_setting(conn, "manager_password_hash") is None:
            set_setting(conn, "manager_password_hash", generate_password_hash("changeme123"))

        if get_setting(conn, "public_token") is None:
            set_setting(conn, "public_token", secrets.token_urlsafe(24))
        if get_setting(conn, "employee_username") is None:
            set_setting(conn, "employee_username", "YFM")
        if get_setting(conn, "employee_password_hash") is None:
            set_setting(conn, "employee_password_hash", generate_password_hash("YouthFirst"))

        conn.commit()


@app.get("/")
def index():
    if session.get("role") in {"manager", "employee"}:
        return render_template(
            "schedule.html",
            app_config={
                "locations": LOCATIONS,
                "readOnly": session.get("role") != "manager",
                "publicMode": False,
                "defaultRotationStart": DEFAULT_ROTATION_START.isoformat(),
                "defaultRotationEnd": DEFAULT_ROTATION_END.isoformat(),
                "defaultWindowStart": DEFAULT_VIEW_START.isoformat(),
                "windowDays": WINDOW_DAYS,
                "role": session.get("role"),
            },
        )

    return render_template("login.html")


@app.get("/schedule")
def schedule_view():
    if session.get("role") not in {"manager", "employee"}:
        return render_template("login.html")

    return render_template(
        "schedule.html",
        app_config={
            "locations": LOCATIONS,
            "readOnly": session.get("role") != "manager",
            "publicMode": False,
            "defaultRotationStart": DEFAULT_ROTATION_START.isoformat(),
            "defaultRotationEnd": DEFAULT_ROTATION_END.isoformat(),
            "defaultWindowStart": DEFAULT_VIEW_START.isoformat(),
            "windowDays": WINDOW_DAYS,
            "role": session.get("role"),
        },
    )


@app.get("/public/<token>")
def public_view(token: str):
    with get_db_connection() as conn:
        expected = get_setting(conn, "public_token", "")

    if not secrets.compare_digest(token, expected):
        return "Invalid public link", 404

    return render_template(
        "schedule.html",
        app_config={
            "locations": LOCATIONS,
            "readOnly": True,
            "publicMode": True,
            "defaultRotationStart": DEFAULT_ROTATION_START.isoformat(),
            "defaultRotationEnd": DEFAULT_ROTATION_END.isoformat(),
            "defaultWindowStart": DEFAULT_VIEW_START.isoformat(),
            "windowDays": WINDOW_DAYS,
            "role": "public",
        },
    )


@app.post("/login")
def login():
    data = request.get_json(silent=True) or {}
    username = str(data.get("username", "")).strip()
    password = str(data.get("password", ""))

    with get_db_connection() as conn:
        manager_username = get_setting(conn, "manager_username", "manager")
        manager_password_hash = get_setting(conn, "manager_password_hash", "")
        employee_username = get_setting(conn, "employee_username", "YFM")
        employee_password_hash = get_setting(conn, "employee_password_hash", "")

    if username == manager_username and check_password_hash(manager_password_hash, password):
        session["role"] = "manager"
        return jsonify({"ok": True, "role": "manager"})

    if employee_password_hash and username == employee_username and check_password_hash(employee_password_hash, password):
        session["role"] = "employee"
        return jsonify({"ok": True, "role": "employee"})

    return jsonify({"ok": False, "error": "Invalid credentials"}), 401


@app.post("/logout")
def logout():
    session.clear()
    return jsonify({"ok": True})


@app.get("/api/auth-status")
def auth_status():
    role = session.get("role")
    return jsonify({"logged_in": bool(role in {"manager", "employee"}), "role": role, "is_manager": role == "manager"})


@app.get("/api/schedule")
def get_schedule():
    location = request.args.get("location", LOCATIONS[0])

    if location not in LOCATIONS:
        return jsonify({"error": "Invalid location"}), 400

    start_raw = request.args.get("start_date") or DEFAULT_VIEW_START.isoformat()
    try:
        start_date = date.fromisoformat(start_raw)
    except ValueError:
        return jsonify({"error": "Invalid start_date"}), 400

    end_date = start_date + timedelta(days=WINDOW_DAYS - 1)
    days: dict[str, dict[str, list[str]]] = {}
    learner_types: dict[str, str] = {}
    for offset in range(WINDOW_DAYS):
        cur = start_date + timedelta(days=offset)
        key = cur.isoformat()
        days[key] = {
            shift: ["" for _ in range(slot_limit)]
            for shift, slot_limit in SHIFT_SLOT_LIMITS.items()
        }
        learner_types[key] = "trainee"

    with get_db_connection() as conn:
        rows = load_entries_for_range(conn, location, start_date, end_date)
        last_updated_row = conn.execute(
            """
            SELECT MAX(updated_at) AS last_updated
            FROM schedule_entries
            WHERE location = ? AND entry_date BETWEEN ? AND ?
            """,
            (location, start_date.isoformat(), end_date.isoformat()),
        ).fetchone()

    for row in rows:
        day_key = row["entry_date"]
        shift = row["shift"]
        slot = int(row["slot"])
        if day_key in days and shift in SHIFTS and 1 <= slot <= SHIFT_SLOT_LIMITS[shift]:
            days[day_key][shift][slot - 1] = row["staff_name"]
            if shift == "trainee":
                role_type = (row["role_type"] or "").strip().lower()
                learner_types[day_key] = "student" if role_type == "student" else "trainee"

    return jsonify(
        {
            "location": location,
            "start_date": start_date.isoformat(),
            "end_date": end_date.isoformat(),
            "window_days": WINDOW_DAYS,
            "days": days,
            "learner_types": learner_types,
            "last_updated": (last_updated_row["last_updated"] if last_updated_row else None),
        }
    )


@app.get("/api/updates")
def check_updates():
    location = request.args.get("location", LOCATIONS[0])
    since = request.args.get("since")

    if location not in LOCATIONS:
        return jsonify({"error": "Invalid location"}), 400

    start_raw = request.args.get("start_date") or DEFAULT_VIEW_START.isoformat()
    try:
        start_date_obj = date.fromisoformat(start_raw)
    except ValueError:
        return jsonify({"error": "Invalid start_date"}), 400

    end_date_obj = start_date_obj + timedelta(days=WINDOW_DAYS - 1)
    start_date = start_date_obj.isoformat()
    end_date = end_date_obj.isoformat()

    with get_db_connection() as conn:
        row = conn.execute(
            """
            SELECT MAX(updated_at) AS last_updated
            FROM schedule_entries
            WHERE location = ? AND entry_date BETWEEN ? AND ?
            """,
            (location, start_date, end_date),
        ).fetchone()

    last_updated = row["last_updated"] if row else None
    changed = bool(last_updated and (not since or last_updated > since))

    return jsonify({"changed": changed, "last_updated": last_updated})


@app.post("/api/schedule/update")
def update_schedule():
    if not is_manager_logged_in():
        return jsonify({"error": "Manager login required"}), 401

    data = request.get_json(silent=True) or {}

    location = data.get("location")
    entry_date = data.get("date")
    shift = data.get("shift")
    slot = data.get("slot")
    staff_name = str(data.get("staff_name", "")).strip()
    role_type = str(data.get("role_type", "")).strip().lower()

    if location not in LOCATIONS:
        return jsonify({"error": "Invalid location"}), 400

    if shift not in SHIFTS:
        return jsonify({"error": "Invalid shift"}), 400

    try:
        parsed_date = date.fromisoformat(str(entry_date))
    except ValueError:
        return jsonify({"error": "Invalid date"}), 400

    try:
        slot_number = int(slot)
    except (TypeError, ValueError):
        return jsonify({"error": "Invalid slot"}), 400

    max_slots_for_shift = SHIFT_SLOT_LIMITS[shift]
    if slot_number < 1 or slot_number > max_slots_for_shift:
        return jsonify({"error": f"Slot must be 1-{max_slots_for_shift} for {shift} shift"}), 400

    if len(staff_name) > 80:
        return jsonify({"error": "Staff name too long"}), 400

    normalized_role_type = ""
    if shift == "trainee":
        normalized_role_type = "student" if role_type == "student" else "trainee"

    updated_at = now_iso()

    with get_db_connection() as conn:
        operation_id = create_operation(conn, session.get("role", "manager"))
        apply_entry_with_log(
            conn,
            operation_id,
            location,
            parsed_date.isoformat(),
            shift,
            slot_number,
            staff_name,
            normalized_role_type,
            updated_at,
        )
        conn.commit()

    return jsonify({"ok": True, "updated_at": updated_at})


@app.post("/api/schedule/clear-month")
def clear_schedule_month():
    if not is_manager_logged_in():
        return jsonify({"error": "Manager login required"}), 401

    data = request.get_json(silent=True) or {}
    location = data.get("location")
    start_raw = data.get("start_date")
    window_days_raw = data.get("window_days", WINDOW_DAYS)

    if location not in LOCATIONS:
        return jsonify({"error": "Invalid location"}), 400

    try:
        start_date_obj = date.fromisoformat(str(start_raw))
    except ValueError:
        return jsonify({"error": "Invalid start_date"}), 400

    try:
        window_days = int(window_days_raw)
    except (TypeError, ValueError):
        return jsonify({"error": "Invalid window_days"}), 400

    if window_days < 1 or window_days > 366:
        return jsonify({"error": "window_days out of range"}), 400

    end_date_obj = start_date_obj + timedelta(days=window_days - 1)
    start_date = start_date_obj.isoformat()
    end_date = end_date_obj.isoformat()

    with get_db_connection() as conn:
        rows = conn.execute(
            """
            SELECT entry_date, shift, slot, staff_name, role_type
            FROM schedule_entries
            WHERE location = ? AND entry_date BETWEEN ? AND ?
            """,
            (location, start_date, end_date),
        ).fetchall()
        operation_id = create_operation(conn, session.get("role", "manager"))
        for row in rows:
            log_change(
                conn,
                operation_id,
                location,
                row["entry_date"],
                row["shift"],
                int(row["slot"]),
                row["staff_name"],
                row["role_type"],
                None,
                None,
            )
        cursor = conn.execute(
            """
            DELETE FROM schedule_entries
            WHERE location = ? AND entry_date BETWEEN ? AND ?
            """,
            (location, start_date, end_date),
        )
        conn.commit()

    return jsonify({"ok": True, "deleted_rows": cursor.rowcount})


@app.post("/api/admin/employee-credentials")
def update_employee_credentials():
    if not is_manager_logged_in():
        return jsonify({"error": "Manager login required"}), 401

    data = request.get_json(silent=True) or {}
    username = str(data.get("username", "")).strip()
    password = str(data.get("password", "")).strip()

    if not username:
        return jsonify({"error": "Employee username is required"}), 400
    if len(username) > 80:
        return jsonify({"error": "Employee username too long"}), 400
    if password and len(password) < 6:
        return jsonify({"error": "Employee password must be at least 6 characters"}), 400

    with get_db_connection() as conn:
        set_setting(conn, "employee_username", username)
        if password:
            set_setting(conn, "employee_password_hash", generate_password_hash(password))
        conn.commit()

    return jsonify({"ok": True, "username": username, "password_updated": bool(password)})


@app.get("/api/presets")
def list_presets():
    location = request.args.get("location", LOCATIONS[0])
    if location not in LOCATIONS:
        return jsonify({"error": "Invalid location"}), 400

    with get_db_connection() as conn:
        rows = conn.execute(
            "SELECT name, rotation_days, updated_at FROM schedule_presets WHERE location = ? ORDER BY name",
            (location,),
        ).fetchall()

    return jsonify(
        {
            "presets": [
                {"name": row["name"], "rotation_days": row["rotation_days"], "updated_at": row["updated_at"]}
                for row in rows
            ]
        }
    )


@app.post("/api/presets/save")
def save_preset():
    if not is_manager_logged_in():
        return jsonify({"error": "Manager login required"}), 401

    data = request.get_json(silent=True) or {}
    location = data.get("location")
    name = str(data.get("name", "")).strip()
    start_raw = data.get("start_date")
    end_raw = data.get("end_date")

    if location not in LOCATIONS:
        return jsonify({"error": "Invalid location"}), 400
    if not name:
        return jsonify({"error": "Preset name is required"}), 400

    try:
        start_date = date.fromisoformat(str(start_raw))
        end_date = date.fromisoformat(str(end_raw))
    except ValueError:
        return jsonify({"error": "Invalid start/end date"}), 400

    if end_date < start_date:
        return jsonify({"error": "End date must be on or after start date"}), 400

    rotation_days = (end_date - start_date).days + 1
    if rotation_days != WINDOW_DAYS:
        return jsonify({"error": f"Preset range must be exactly {WINDOW_DAYS} days (8 weeks)"}), 400

    with get_db_connection() as conn:
        rows = load_entries_for_range(conn, location, start_date, end_date)
        pattern: dict[str, dict[str, dict[str, str]]] = {}
        for row in rows:
            entry_date = date.fromisoformat(row["entry_date"])
            day_offset = (entry_date - start_date).days
            shift = row["shift"]
            slot = str(int(row["slot"]))
            if day_offset < 0 or day_offset >= rotation_days:
                continue
            day_key = str(day_offset)
            if day_key not in pattern:
                pattern[day_key] = {}
            if shift not in pattern[day_key]:
                pattern[day_key][shift] = {}
            pattern[day_key][shift][slot] = row["staff_name"]
            if shift == "trainee":
                pattern[day_key].setdefault("role_type", {})
                pattern[day_key]["role_type"]["1"] = (row["role_type"] or "trainee").lower()

        conn.execute(
            """
            INSERT INTO schedule_presets (name, location, rotation_days, payload_json, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(name, location) DO UPDATE SET
                rotation_days = excluded.rotation_days,
                payload_json = excluded.payload_json,
                updated_at = excluded.updated_at
            """,
            (name, location, rotation_days, json.dumps(pattern), now_iso()),
        )
        conn.commit()

    return jsonify({"ok": True, "name": name, "rotation_days": rotation_days})


@app.post("/api/presets/apply")
def apply_preset():
    if not is_manager_logged_in():
        return jsonify({"error": "Manager login required"}), 401

    data = request.get_json(silent=True) or {}
    location = data.get("location")
    name = str(data.get("name", "")).strip()
    target_start_raw = data.get("target_start_date")
    try:
        weeks = int(data.get("weeks", 8))
    except (TypeError, ValueError):
        return jsonify({"error": "Invalid weeks value"}), 400

    if location not in LOCATIONS:
        return jsonify({"error": "Invalid location"}), 400
    if not name:
        return jsonify({"error": "Preset name is required"}), 400
    if weeks != 8:
        return jsonify({"error": "Apply preset currently supports exactly 8 weeks"}), 400

    try:
        target_start = date.fromisoformat(str(target_start_raw))
    except ValueError:
        return jsonify({"error": "Invalid target start date"}), 400

    with get_db_connection() as conn:
        preset = conn.execute(
            "SELECT rotation_days, payload_json FROM schedule_presets WHERE name = ? AND location = ?",
            (name, location),
        ).fetchone()
        if not preset:
            return jsonify({"error": "Preset not found"}), 404

        rotation_days = int(preset["rotation_days"])
        pattern = json.loads(preset["payload_json"])
        operation_id = create_operation(conn, session.get("role", "manager"))
        total_days = apply_preset_pattern(conn, operation_id, location, pattern, rotation_days, target_start, weeks)
        conn.commit()

    return jsonify({"ok": True, "applied_days": total_days, "weeks": weeks})


@app.post("/api/presets/apply-next")
def apply_preset_next():
    if not is_manager_logged_in():
        return jsonify({"error": "Manager login required"}), 401

    data = request.get_json(silent=True) or {}
    location = data.get("location")
    name = str(data.get("name", "")).strip()
    try:
        weeks = int(data.get("weeks", 8))
    except (TypeError, ValueError):
        return jsonify({"error": "Invalid weeks value"}), 400

    if location not in LOCATIONS:
        return jsonify({"error": "Invalid location"}), 400
    if not name:
        return jsonify({"error": "Preset name is required"}), 400
    if weeks != 8:
        return jsonify({"error": "Apply next currently supports exactly 8 weeks"}), 400

    with get_db_connection() as conn:
        preset = conn.execute(
            "SELECT rotation_days, payload_json FROM schedule_presets WHERE name = ? AND location = ?",
            (name, location),
        ).fetchone()
        if not preset:
            return jsonify({"error": "Preset not found"}), 404

        latest = conn.execute(
            "SELECT MAX(entry_date) AS max_date FROM schedule_entries WHERE location = ?",
            (location,),
        ).fetchone()
        if latest and latest["max_date"]:
            target_start = date.fromisoformat(latest["max_date"]) + timedelta(days=1)
        else:
            target_start = DEFAULT_ROTATION_START

        rotation_days = int(preset["rotation_days"])
        pattern = json.loads(preset["payload_json"])
        operation_id = create_operation(conn, session.get("role", "manager"))
        total_days = apply_preset_pattern(conn, operation_id, location, pattern, rotation_days, target_start, weeks)
        conn.commit()

    return jsonify(
        {
            "ok": True,
            "applied_days": total_days,
            "weeks": weeks,
            "target_start_date": target_start.isoformat(),
        }
    )


@app.post("/api/schedule/undo-last")
def undo_last_change():
    if not is_manager_logged_in():
        return jsonify({"error": "Manager login required"}), 401

    with get_db_connection() as conn:
        op = conn.execute("SELECT id FROM change_operations ORDER BY id DESC LIMIT 1").fetchone()
        if not op:
            return jsonify({"error": "Nothing to undo"}), 400

        op_id = int(op["id"])
        changes = conn.execute(
            """
            SELECT location, entry_date, shift, slot, prev_staff_name, prev_role_type
            FROM change_entries
            WHERE operation_id = ?
            ORDER BY id DESC
            """,
            (op_id,),
        ).fetchall()

        updated_at = now_iso()
        for row in changes:
            location = row["location"]
            entry_date = row["entry_date"]
            shift = row["shift"]
            slot = int(row["slot"])
            prev_staff = row["prev_staff_name"]
            prev_role = row["prev_role_type"] or ""

            if prev_staff is None:
                conn.execute(
                    """
                    DELETE FROM schedule_entries
                    WHERE location = ? AND entry_date = ? AND shift = ? AND slot = ?
                    """,
                    (location, entry_date, shift, slot),
                )
            else:
                conn.execute(
                    """
                    INSERT INTO schedule_entries (location, entry_date, shift, slot, staff_name, role_type, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(location, entry_date, shift, slot) DO UPDATE SET
                        staff_name = excluded.staff_name,
                        role_type = excluded.role_type,
                        updated_at = excluded.updated_at
                    """,
                    (location, entry_date, shift, slot, prev_staff, prev_role, updated_at),
                )

        conn.execute("DELETE FROM change_entries WHERE operation_id = ?", (op_id,))
        conn.execute("DELETE FROM change_operations WHERE id = ?", (op_id,))
        conn.commit()

    return jsonify({"ok": True, "undone_operation_id": op_id, "changed_rows": len(changes)})


@app.get("/api/schedule/export")
def export_schedule_window():
    location = request.args.get("location", LOCATIONS[0])
    if location not in LOCATIONS:
        return jsonify({"error": "Invalid location"}), 400

    start_raw = request.args.get("start_date") or DEFAULT_VIEW_START.isoformat()
    try:
        start_date = date.fromisoformat(start_raw)
    except ValueError:
        return jsonify({"error": "Invalid start_date"}), 400
    end_date = start_date + timedelta(days=WINDOW_DAYS - 1)

    days: dict[str, dict[str, list[str]]] = {}
    learner_types: dict[str, str] = {}
    for offset in range(WINDOW_DAYS):
        cur = start_date + timedelta(days=offset)
        key = cur.isoformat()
        days[key] = {
            shift: ["" for _ in range(slot_limit)]
            for shift, slot_limit in SHIFT_SLOT_LIMITS.items()
        }
        learner_types[key] = "trainee"

    with get_db_connection() as conn:
        rows = load_entries_for_range(conn, location, start_date, end_date)

    for row in rows:
        day_key = row["entry_date"]
        shift = row["shift"]
        slot = int(row["slot"])
        if day_key in days and shift in SHIFTS and 1 <= slot <= SHIFT_SLOT_LIMITS[shift]:
            days[day_key][shift][slot - 1] = row["staff_name"]
            if shift == "trainee":
                learner_types[day_key] = "student" if (row["role_type"] or "").lower() == "student" else "trainee"

    lines = ["Date\tLocation\tShift\tSlot\tName"]
    for offset in range(WINDOW_DAYS):
        iso = (start_date + timedelta(days=offset)).isoformat()
        day_data = days[iso]
        for shift in ("day", "night"):
            for idx, name in enumerate(day_data[shift], start=1):
                if name.strip():
                    lines.append(f"{iso}\t{location}\t{shift}\t{idx}\t{name.strip()}")
        trainee_name = (day_data["trainee"][0] or "").strip()
        if trainee_name:
            role_label = learner_types[iso]
            lines.append(f"{iso}\t{location}\t{role_label}\t1\t{trainee_name}")

    return jsonify({"text": "\n".join(lines)})


@app.get("/api/publish-link")
def publish_link():
    if not is_manager_logged_in():
        return jsonify({"error": "Manager login required"}), 401

    with get_db_connection() as conn:
        token = get_setting(conn, "public_token", "")

    return jsonify({"link": f"{base_url()}{url_for('public_view', token=token)}"})


@app.post("/api/publish-link/rotate")
def rotate_publish_link():
    if not is_manager_logged_in():
        return jsonify({"error": "Manager login required"}), 401

    new_token = secrets.token_urlsafe(24)

    with get_db_connection() as conn:
        set_setting(conn, "public_token", new_token)
        conn.commit()

    return jsonify({"ok": True, "link": f"{base_url()}{url_for('public_view', token=new_token)}"})


init_db()


def run(host: str = DEFAULT_HOST, port: int = DEFAULT_PORT) -> None:
    app.run(host=host, port=port, debug=False)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Run the schedule app server.")
    parser.add_argument("--host", default=DEFAULT_HOST, help="Host interface to bind.")
    parser.add_argument("--port", default=DEFAULT_PORT, type=int, help="TCP port to listen on.")
    args = parser.parse_args()
    run(host=args.host, port=args.port)
