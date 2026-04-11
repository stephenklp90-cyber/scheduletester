import argparse
import calendar
import os
import secrets
import sqlite3
from datetime import date, datetime, timezone
from pathlib import Path

from flask import Flask, jsonify, render_template, request, session, url_for
from werkzeug.security import check_password_hash, generate_password_hash

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("SCHEDULE_DB_PATH", str(BASE_DIR / "schedule.db"))).resolve()
DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = int(os.environ.get("PORT", "5000"))
PUBLIC_BASE_URL = os.environ.get("PUBLIC_BASE_URL", "").strip()

LOCATIONS = ["MRC", "SPC", "SPC2", "FN2", "WSH", "Adult"]
SHIFTS = ["day", "night"]
MAX_SLOTS = 3

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
            "day": ["" for _ in range(MAX_SLOTS)],
            "night": ["" for _ in range(MAX_SLOTS)],
        }

    return payload


def is_manager_logged_in() -> bool:
    return bool(session.get("is_manager", False))


def base_url() -> str:
    if PUBLIC_BASE_URL:
        return PUBLIC_BASE_URL.rstrip("/")
    return request.url_root.rstrip("/")


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
                updated_at TEXT NOT NULL,
                UNIQUE(location, entry_date, shift, slot)
            )
            """
        )

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
            """
        )

        if get_setting(conn, "manager_username") is None:
            set_setting(conn, "manager_username", "manager")

        if get_setting(conn, "manager_password_hash") is None:
            set_setting(conn, "manager_password_hash", generate_password_hash("changeme123"))

        if get_setting(conn, "public_token") is None:
            set_setting(conn, "public_token", secrets.token_urlsafe(24))

        conn.commit()


@app.get("/")
def index():
    return render_template(
        "schedule.html",
        app_config={
            "locations": LOCATIONS,
            "readOnly": False,
            "publicMode": False,
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

    if username == manager_username and check_password_hash(manager_password_hash, password):
        session["is_manager"] = True
        return jsonify({"ok": True})

    return jsonify({"ok": False, "error": "Invalid credentials"}), 401


@app.post("/logout")
def logout():
    session.clear()
    return jsonify({"ok": True})


@app.get("/api/auth-status")
def auth_status():
    return jsonify({"is_manager": is_manager_logged_in()})


@app.get("/api/schedule")
def get_schedule():
    location = request.args.get("location", LOCATIONS[0])

    if location not in LOCATIONS:
        return jsonify({"error": "Invalid location"}), 400

    try:
        year, month = parse_year_month(request.args.get("year"), request.args.get("month"))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    days = empty_month_payload(year, month)
    start_date = date(year, month, 1).isoformat()
    end_day = calendar.monthrange(year, month)[1]
    end_date = date(year, month, end_day).isoformat()

    with get_db_connection() as conn:
        rows = conn.execute(
            """
            SELECT entry_date, shift, slot, staff_name
            FROM schedule_entries
            WHERE location = ? AND entry_date BETWEEN ? AND ?
            ORDER BY entry_date, shift, slot
            """,
            (location, start_date, end_date),
        ).fetchall()

        last_updated_row = conn.execute(
            """
            SELECT MAX(updated_at) AS last_updated
            FROM schedule_entries
            WHERE location = ? AND entry_date BETWEEN ? AND ?
            """,
            (location, start_date, end_date),
        ).fetchone()

    for row in rows:
        day_key = str(int(row["entry_date"].split("-")[2]))
        shift = row["shift"]
        slot = int(row["slot"])
        if day_key in days and shift in SHIFTS and 1 <= slot <= MAX_SLOTS:
            days[day_key][shift][slot - 1] = row["staff_name"]

    return jsonify(
        {
            "location": location,
            "year": year,
            "month": month,
            "days": days,
            "last_updated": (last_updated_row["last_updated"] if last_updated_row else None),
        }
    )


@app.get("/api/updates")
def check_updates():
    location = request.args.get("location", LOCATIONS[0])
    since = request.args.get("since")

    if location not in LOCATIONS:
        return jsonify({"error": "Invalid location"}), 400

    try:
        year, month = parse_year_month(request.args.get("year"), request.args.get("month"))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    start_date = date(year, month, 1).isoformat()
    end_day = calendar.monthrange(year, month)[1]
    end_date = date(year, month, end_day).isoformat()

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

    if slot_number < 1 or slot_number > MAX_SLOTS:
        return jsonify({"error": "Slot must be 1-3"}), 400

    if len(staff_name) > 80:
        return jsonify({"error": "Staff name too long"}), 400

    updated_at = now_iso()

    with get_db_connection() as conn:
        conn.execute(
            """
            INSERT INTO schedule_entries (location, entry_date, shift, slot, staff_name, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(location, entry_date, shift, slot)
            DO UPDATE SET
                staff_name = excluded.staff_name,
                updated_at = excluded.updated_at
            """,
            (location, parsed_date.isoformat(), shift, slot_number, staff_name, updated_at),
        )
        conn.commit()

    return jsonify({"ok": True, "updated_at": updated_at})


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
