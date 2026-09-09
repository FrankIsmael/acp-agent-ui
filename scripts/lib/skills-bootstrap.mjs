import { pythonCommand } from './easybits.mjs';
export function skillsBootstrap({ repository, branch = 'main', repoDir = '/data/repo', cwd = '/data/work' }) {
  const url = new URL(repository);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Skills repository must be an HTTPS URL without embedded credentials.');
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) || branch.includes('..')) throw new Error('Invalid skills branch');
  if (![repoDir, cwd].every(path => path.startsWith('/data/')) || repoDir === cwd) throw new Error('Use separate repository and work directories under /data.');
  return pythonCommand(`import pathlib, subprocess, sys
url, branch, repo_name, cwd_name = sys.argv[1:]
repo, cwd = pathlib.Path(repo_name), pathlib.Path(cwd_name)
def run(*args):
 result = subprocess.run(args, capture_output=True, text=True)
 if result.returncode: raise RuntimeError("Skills repository command failed: " + args[0])
 return result.stdout.strip()
if repo.exists():
 if not (repo / ".git").is_dir(): raise RuntimeError("Skills destination already exists and is not a repository")
 if run("git", "-C", str(repo), "remote", "get-url", "origin") != url: raise RuntimeError("Skills repository origin differs; existing work was preserved")
 if run("git", "-C", str(repo), "status", "--porcelain"): raise RuntimeError("Uncommitted skills found; commit them before refreshing")
 run("git", "-C", str(repo), "fetch", "--depth", "1", "origin", branch)
 run("git", "-C", str(repo), "checkout", "-B", branch, "FETCH_HEAD")
else:
 repo.parent.mkdir(parents=True, exist_ok=True)
 run("git", "clone", "--depth", "1", "--branch", branch, "--", url, str(repo))
(repo / ".agents" / "skills").mkdir(parents=True, exist_ok=True)
for name in (".agents", ".goose", ".claude"):
 source = repo / name / "skills"
 if not source.is_dir(): continue
 destination = cwd / name / "skills"
 destination.parent.mkdir(parents=True, exist_ok=True)
 if destination.is_symlink():
  if destination.resolve() != source.resolve(): raise RuntimeError("A skills link points elsewhere; existing work was preserved")
 elif destination.exists(): raise RuntimeError("A skills directory already exists; existing work was preserved")
 else: destination.symlink_to(source, target_is_directory=True)
print("Project skills linked successfully")
`, [repository, branch, repoDir, cwd]);
}

/** Para Goose manual; Ghosty ya configura su propia raíz persistente. */
export function gooseStorageBootstrap(service) {
  if (!/^[A-Za-z0-9_.@-]+\.service$/.test(service)) throw new Error('Invalid Goose service');
  return pythonCommand(`import pathlib, subprocess, sqlite3, sys
from contextlib import closing
service = sys.argv[1]
source = pathlib.Path("/root/.local/share/goose/sessions/sessions.db")
target = pathlib.Path("/data/state/goose/sessions/sessions.db")
dropin = pathlib.Path("/etc/systemd/system") / (service + ".d") / "acp-memory.conf"
content = "[Service]\\nEnvironment=XDG_DATA_HOME=/data/state\\n"
def run(*args):
 if subprocess.run(args, capture_output=True).returncode: raise RuntimeError("Could not configure persistent Goose storage")
if subprocess.run(["systemctl", "show", service, "--property=LoadState", "--value"],capture_output=True,text=True).stdout.strip() != "loaded": raise RuntimeError("Goose service not found")
if not dropin.exists() or dropin.read_text() != content:
 if source.exists() and target.exists(): raise RuntimeError("Both session databases exist; reconcile them before changing Goose storage")
 running = subprocess.run(["systemctl", "is-active", "--quiet", service]).returncode == 0
 run("systemctl", "stop", service)
 try:
  target.parent.mkdir(parents=True, exist_ok=True)
  if source.exists() and not target.exists():
   with closing(sqlite3.connect(f"file:{source}?mode=ro", uri=True)) as src, closing(sqlite3.connect(target)) as dst:
    src.backup(dst)
  dropin.parent.mkdir(parents=True, exist_ok=True)
  dropin.write_text(content)
  run("systemctl", "daemon-reload")
 finally:
  if running: run("systemctl", "start", service)
print("Goose persistent storage configured")
`, [service]);
}
