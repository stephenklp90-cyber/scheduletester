# Schedule Application

A Flask-based scheduling app with:

- Six location tabs: `MRC`, `SPC`, `SPC2`, `FN2`, `WSH`, `Adult`
- Month-by-month navigation in a weekly calendar layout
- Day and night shifts per day
- Up to 3 staff slots per shift
- Manager login required for edits
- Public read-only share link
- Live updates via background polling

## Run Local

```powershell
python -m pip install -r requirements.txt
python app.py --port 5050
```

Open `http://127.0.0.1:5050`.

## Manager Login

Default credentials:

- Username: `manager`
- Password: `changeme123`

Credentials are initialized in `schedule.db` on first run.

## PythonAnywhere Deployment

1. Push this project to GitHub.
2. In PythonAnywhere, open a Bash console:

```bash
git clone https://github.com/<your-user>/<your-repo>.git
cd <your-repo>
python3.10 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

3. In PythonAnywhere Web tab:
- Add a new web app
- Choose Manual configuration (Python 3.10)
- Set Source code and Working directory to `/home/<username>/<your-repo>`
- Set Virtualenv to `/home/<username>/<your-repo>/venv`

4. Edit the WSGI file to:

```python
import sys
path = '/home/<username>/<your-repo>'
if path not in sys.path:
    sys.path.insert(0, path)

from app import app as application
```

5. Add environment variables in Web tab:
- `PUBLIC_BASE_URL=https://<username>.pythonanywhere.com`
- `SCHEDULE_DB_PATH=/home/<username>/<your-repo>/schedule.db`
- `SCHEDULE_SECRET_KEY=<long-random-string>`

6. Reload the web app.

After deployment, log in as manager and click `Get Public Link`.

## Environment Variables

- `PORT`: Used locally/when provided by host.
- `PUBLIC_BASE_URL`: Used for generated share links.
- `SCHEDULE_DB_PATH`: SQLite file path.
- `SCHEDULE_SECRET_KEY`: Flask session secret.

## Notes

- Polling runs every 8 seconds for live refresh.
- For production, use HTTPS and regular backups of the database file.
