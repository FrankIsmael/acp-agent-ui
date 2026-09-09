// Estos programas se ejecutan en la caja. Nunca reciben la llave de EasyBits.
export const inspectDatabase = `
from contextlib import closing
def inspect(path):
 with closing(sqlite3.connect(f"file:{path}?mode=ro", uri=True)) as db:
  if db.execute("PRAGMA quick_check").fetchone()[0] != "ok": raise RuntimeError("SQLite integrity check failed")
  counts = {table: db.execute("SELECT count(*) FROM " + table).fetchone()[0] for table in ("sessions", "messages")}
 return counts
`;
export const backupDatabase = `import pathlib, sqlite3, tempfile, json, hashlib, sys, os
${inspectDatabase}
source = pathlib.Path(sys.argv[1])
if not source.is_file(): raise FileNotFoundError("Session database does not exist")
os.umask(0o077)
folder = pathlib.Path(tempfile.mkdtemp(prefix="acp-memory-"))
target = folder / "sessions.db"
with closing(sqlite3.connect(f"file:{source}?mode=ro", uri=True)) as src, closing(sqlite3.connect(target)) as dst:
 src.backup(dst)
 dst.execute("PRAGMA journal_mode=DELETE")
print(json.dumps({"path":str(target), "size":target.stat().st_size, "sha256":hashlib.file_digest(target.open("rb"), "sha256").hexdigest(), **inspect(target)}))
`;
export const uploadDatabase = `import subprocess, sys
result = subprocess.run(["curl", "--fail", "--silent", "--max-time", "300", "--request", "PUT", "--header", "Content-Type: application/vnd.sqlite3", "--upload-file", sys.argv[1], "--output", "/dev/null", sys.argv[2]], capture_output=True)
if result.returncode: raise RuntimeError("Signed backup upload failed")
`;
export const restoreDatabase = `import pathlib, sqlite3, tempfile, json, hashlib, sys, os, subprocess, shutil, re
${inspectDatabase}
url, name, service, force, expected = sys.argv[1:]
if not re.fullmatch(r"[A-Za-z0-9_.@-]+\\.service", service): raise ValueError("Invalid service name")
target = pathlib.Path(name)
if target.exists() and force != "true": raise FileExistsError("Destination exists; use --force to replace it")
os.umask(0o077)
target.parent.mkdir(parents=True, exist_ok=True)
folder = pathlib.Path(tempfile.mkdtemp(prefix=".acp-restore-", dir=target.parent))
staged = folder / "sessions.db"
was_running = False
stopped = False
installed = False
rollback = None
try:
 result = subprocess.run(["curl", "--fail", "--silent", "--max-time", "300", "--output", str(staged), url], capture_output=True)
 if result.returncode: raise RuntimeError("Signed backup download failed")
 digest = hashlib.file_digest(staged.open("rb"), "sha256").hexdigest()
 if expected and digest != expected: raise RuntimeError("Backup checksum mismatch")
 counts = inspect(staged)
 if subprocess.run(["systemctl", "show", service, "--property=LoadState", "--value"], capture_output=True, text=True).stdout.strip() != "loaded": raise RuntimeError("Agent service does not exist")
 was_running = subprocess.run(["systemctl", "is-active", "--quiet", service]).returncode == 0
 if subprocess.run(["systemctl", "stop", service], capture_output=True).returncode: raise RuntimeError("Could not stop agent service")
 stopped = True
 if subprocess.run(["systemctl", "is-active", "--quiet", service]).returncode == 0: raise RuntimeError("Agent is still running")
 if target.exists() and force != "true": raise FileExistsError("Destination appeared during restore")
 if target.exists() or pathlib.Path(str(target)+"-wal").exists() or pathlib.Path(str(target)+"-shm").exists():
  rollback = pathlib.Path(tempfile.mkdtemp(prefix=".acp-before-restore-", dir=target.parent))
  for suffix in ("", "-wal", "-shm"):
   old = pathlib.Path(str(target)+suffix)
   if old.exists(): os.replace(old, rollback / ("sessions.db"+suffix))
 try:
  os.replace(staged, target)
  inspect(target)
  installed = True
 except BaseException:
  if target.exists(): target.unlink()
  if rollback:
   for old in rollback.iterdir(): os.replace(old, pathlib.Path(str(target)+old.name.removeprefix("sessions.db")))
  raise
 print(json.dumps({"path":str(target), "sha256":digest, **counts, "previousDatabase":str(rollback) if rollback else None}))
finally:
 shutil.rmtree(folder)
 if stopped and was_running:
  if subprocess.run(["systemctl", "start", service], capture_output=True).returncode: raise RuntimeError("Database restored but agent service could not restart")
`;
