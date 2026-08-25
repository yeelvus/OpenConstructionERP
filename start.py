#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Start the whole OpenConstructionERP stack from this repository.

    python3 start.py              all-in-one app  →  http://127.0.0.1:8080
    python3 start.py --dev        Docker Postgres/Redis/MinIO + API + Vite
    python3 start.py --docker     docker compose quickstart

Uses ``.venv`` when present (re-execs into it). Ctrl+C stops every child.
"""
from __future__ import annotations

import argparse
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BACKEND = ROOT / "backend"
FRONTEND = ROOT / "frontend"
VENV = ROOT / ".venv"
DEFAULT_HOST = "127.0.0.1"
APP_PORT = 8080
API_PORT = 8000
VITE_PORT = 5173
DEMO_EMAIL = "demo@openconstructionerp.com"
DEMO_PASSWORD = "DemoPass1234!"
DEV_DATABASE_URL = "postgresql+asyncpg://oe:oe@127.0.0.1:5432/openestimate"
COMPOSE_SERVICES = ("postgres", "redis", "minio")


def _is_venv_python(executable: Path) -> bool:
    try:
        return Path(sys.executable).resolve() == executable.resolve()
    except OSError:
        return False


def venv_python() -> Path:
    if sys.platform == "win32":
        return VENV / "Scripts" / "python.exe"
    return VENV / "bin" / "python"


def reexec_in_venv() -> None:
    py = venv_python()
    if py.is_file() and not _is_venv_python(py):
        os.execv(str(py), [str(py), *sys.argv])


def say(msg: str) -> None:
    print(msg, flush=True)


def fail(msg: str, code: int = 1) -> None:
    print(f"ERROR: {msg}", file=sys.stderr, flush=True)
    raise SystemExit(code)


def port_open(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.4)
        return sock.connect_ex((host, port)) == 0


def wait_port(host: str, port: int, timeout: float, label: str) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if port_open(host, port):
            return
        time.sleep(0.4)
    fail(f"{label} did not start on {host}:{port} within {int(timeout)}s")


def wait_http(url: str, timeout: float) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as response:
                if 200 <= response.status < 500:
                    return True
        except (urllib.error.URLError, TimeoutError, OSError):
            time.sleep(0.5)
    return False


def which(name: str) -> str | None:
    return shutil.which(name)


def run(cmd: list[str], **kwargs) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, cwd=str(kwargs.pop("cwd", ROOT)), check=kwargs.pop("check", True), **kwargs)


def find_bootstrap_python() -> str:
    for candidate in ("python3.13", "python3.12", sys.executable):
        path = which(candidate) if candidate != sys.executable else candidate
        if not path:
            continue
        try:
            out = subprocess.check_output(
                [path, "-c", "import sys; print(f'{sys.version_info[0]}.{sys.version_info[1]}')"],
                text=True,
            ).strip()
        except (OSError, subprocess.CalledProcessError):
            continue
        major, minor = (int(part) for part in out.split("."))
        if (major, minor) >= (3, 12) and (major, minor) < (3, 14):
            return path
    fail("Need Python 3.12 or 3.13 to create .venv (3.14 is not supported by this project).")


def ensure_venv(setup: bool) -> Path:
    py = venv_python()
    if py.is_file():
        return py
    if not setup:
        fail(f"Missing {py}. Re-run with --setup to create .venv and install dependencies.")
    bootstrap = find_bootstrap_python()
    say(f"Creating virtualenv with {bootstrap} …")
    run([bootstrap, "-m", "venv", str(VENV)])
    py = venv_python()
    if not py.is_file():
        fail("Failed to create .venv")
    return py


def package_importable(py: Path) -> bool:
    try:
        subprocess.check_call(
            [str(py), "-c", "import openconstructionerp, app"],
            cwd=str(BACKEND),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return True
    except subprocess.CalledProcessError:
        return False


def ensure_backend(py: Path, setup: bool) -> None:
    if package_importable(py):
        return
    if not setup:
        fail("Backend package is not installed in .venv. Re-run with --setup.")
    say("Installing backend into .venv (pip install -e ./backend[server]) …")
    run([str(py), "-m", "pip", "install", "-U", "pip"], cwd=ROOT)
    run([str(py), "-m", "pip", "install", "-e", f"{BACKEND}[server]"], cwd=ROOT)
    if not package_importable(py):
        fail("Backend install finished but `import openconstructionerp` still fails.")


def ensure_frontend(setup: bool) -> None:
    vite = FRONTEND / "node_modules" / ".bin" / ("vite.cmd" if sys.platform == "win32" else "vite")
    if vite.is_file():
        return
    if not setup:
        fail("frontend/node_modules is missing. Re-run with --setup.")
    npm = which("npm")
    if not npm:
        fail("npm not found. Install Node.js 20+ and re-run with --setup.")
    say("Installing frontend dependencies (npm install) …")
    run([npm, "install"], cwd=FRONTEND)


def spawn(cmd: list[str], *, cwd: Path, env: dict[str, str] | None = None) -> subprocess.Popen:
    kwargs: dict = {
        "cwd": str(cwd),
        "env": env or os.environ.copy(),
    }
    if sys.platform != "win32":
        kwargs["start_new_session"] = True
    else:
        kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP  # type: ignore[attr-defined]
    say("  $ " + " ".join(cmd))
    return subprocess.Popen(cmd, **kwargs)


def stop_proc(proc: subprocess.Popen | None) -> None:
    if proc is None or proc.poll() is not None:
        return
    try:
        if sys.platform != "win32":
            os.killpg(proc.pid, signal.SIGTERM)
        else:
            proc.send_signal(signal.CTRL_BREAK_EVENT)  # type: ignore[attr-defined]
    except (ProcessLookupError, OSError):
        proc.terminate()
    try:
        proc.wait(timeout=8)
    except subprocess.TimeoutExpired:
        if sys.platform != "win32":
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except (ProcessLookupError, OSError):
                proc.kill()
        else:
            proc.kill()


def docker_compose() -> list[str]:
    docker = which("docker")
    if docker:
        probe = subprocess.run(
            [docker, "compose", "version"],
            cwd=str(ROOT),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        if probe.returncode == 0:
            return [docker, "compose"]
    compose = which("docker-compose")
    if compose:
        return [compose]
    fail("Docker Compose not found. Install Docker Desktop, or use: python3 start.py")


def start_infra() -> None:
    compose = docker_compose()
    say("Starting Postgres / Redis / MinIO …")
    run(compose + ["up", "-d", *COMPOSE_SERVICES], cwd=ROOT)
    wait_port("127.0.0.1", 5432, 45, "PostgreSQL")


def ensure_quickstart_env() -> None:
    env_path = ROOT / ".env"
    if env_path.exists():
        return
    say("Writing local .env (not committed) with POSTGRES_PASSWORD and JWT_SECRET …")
    password = os.urandom(18).hex()
    jwt = os.urandom(32).hex()
    env_path.write_text(
        f"POSTGRES_PASSWORD={password}\nJWT_SECRET={jwt}\nOE_BIND=127.0.0.1\nOE_PORT={APP_PORT}\n",
        encoding="utf-8",
    )


def print_banner(url: str) -> None:
    say("")
    say("=" * 64)
    say("  OpenConstructionERP is starting")
    say(f"  Open:  {url}")
    say(f"  Login: {DEMO_EMAIL}")
    say(f"         {DEMO_PASSWORD}")
    say("  Stop with Ctrl+C")
    say("=" * 64)
    say("")


def run_app(args: argparse.Namespace, py: Path) -> None:
    if port_open(args.host, args.port):
        fail(f"Port {args.port} is already in use. Stop the other process or pass --port.")
    cmd = [str(py), "-m", "openconstructionerp", "serve", "--host", args.host, "--port", str(args.port)]
    if args.open:
        cmd.append("--open")
    if args.data_dir:
        cmd.extend(["--data-dir", args.data_dir])
    extra = list(args.extra or [])
    if extra and extra[0] == "--":
        extra = extra[1:]
    cmd.extend(extra)
    print_banner(f"http://{args.host}:{args.port}")
    os.chdir(BACKEND)
    os.execv(cmd[0], cmd)


def run_dev(args: argparse.Namespace, py: Path) -> None:
    children: list[subprocess.Popen] = []

    def shutdown(_signum=None, _frame=None) -> None:
        say("\nStopping backend and frontend …")
        for proc in reversed(children):
            stop_proc(proc)
        raise SystemExit(0)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    env = os.environ.copy()
    if which("docker"):
        try:
            start_infra()
            env["DATABASE_URL"] = DEV_DATABASE_URL
        except SystemExit:
            raise
        except Exception as exc:
            say(f"Docker infra failed ({exc}); backend will use embedded PostgreSQL.")
    else:
        say("Docker not found; backend will use embedded PostgreSQL.")

    if port_open(DEFAULT_HOST, API_PORT):
        fail(f"Port {API_PORT} is already in use (backend).")
    if port_open(DEFAULT_HOST, VITE_PORT):
        fail(f"Port {VITE_PORT} is already in use (frontend).")

    npm = which("npm")
    if not npm:
        fail("npm not found. Install Node.js 20+.")

    say("Starting API (uvicorn :8000) …")
    backend = spawn(
        [
            str(py),
            "-m",
            "uvicorn",
            "app.main:create_app",
            "--factory",
            "--reload",
            "--host",
            DEFAULT_HOST,
            "--port",
            str(API_PORT),
        ],
        cwd=BACKEND,
        env=env,
    )
    children.append(backend)

    say("Starting frontend (Vite :5173) …")
    frontend = spawn([npm, "run", "dev"], cwd=FRONTEND, env=os.environ.copy())
    children.append(frontend)

    wait_port(DEFAULT_HOST, API_PORT, 60, "Backend")
    wait_port(DEFAULT_HOST, VITE_PORT, 60, "Frontend")
    print_banner(f"http://{DEFAULT_HOST}:{VITE_PORT}")
    say(f"  API:   http://{DEFAULT_HOST}:{API_PORT}")
    say(f"  Docs:  http://{DEFAULT_HOST}:{API_PORT}/docs")
    if args.open:
        webbrowser.open(f"http://{DEFAULT_HOST}:{VITE_PORT}")

    while True:
        if backend.poll() is not None:
            stop_proc(frontend)
            fail(f"Backend exited with code {backend.returncode}")
        if frontend.poll() is not None:
            stop_proc(backend)
            fail(f"Frontend exited with code {frontend.returncode}")
        time.sleep(0.5)


def run_docker(args: argparse.Namespace) -> None:
    compose = docker_compose()
    ensure_quickstart_env()
    say("Starting docker compose quickstart (Postgres + unified app) …")
    run(compose + ["-f", "docker-compose.quickstart.yml", "up", "--build", "-d"], cwd=ROOT)
    url = f"http://127.0.0.1:{APP_PORT}"
    say("Waiting for http://127.0.0.1:8080/api/health …")
    if not wait_http(f"{url}/api/health", 180):
        say("Health check timed out; containers may still be starting. Check: docker compose -f docker-compose.quickstart.yml logs -f")
    print_banner(url)
    say("Stop later with:")
    say("  docker compose -f docker-compose.quickstart.yml down")
    if args.open:
        webbrowser.open(url)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Start OpenConstructionERP from this repository.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "examples:\n"
            "  python3 start.py\n"
            "  python3 start.py --dev --open\n"
            "  python3 start.py --docker\n"
            "  python3 start.py --setup\n"
        ),
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dev", action="store_true", help="Source-dev stack: Docker infra + uvicorn :8000 + Vite :5173")
    mode.add_argument("--docker", action="store_true", help="docker compose -f docker-compose.quickstart.yml up")
    parser.add_argument("--setup", action="store_true", help="Create .venv and install backend/frontend if missing")
    parser.add_argument("--open", action="store_true", default=True, help="Open the browser (default)")
    parser.add_argument("--no-open", action="store_false", dest="open", help="Do not open the browser")
    parser.add_argument("--host", default=DEFAULT_HOST, help=f"All-in-one bind host (default {DEFAULT_HOST})")
    parser.add_argument("--port", type=int, default=APP_PORT, help=f"All-in-one port (default {APP_PORT})")
    parser.add_argument("--data-dir", default="", help="Override data directory for all-in-one mode")
    parser.add_argument("extra", nargs=argparse.REMAINDER, help="Extra args after -- are passed to openconstructionerp serve")
    return parser.parse_args()


def main() -> None:
    if not (BACKEND / "app" / "main.py").is_file():
        fail(f"Does not look like the OpenConstructionERP repo: {ROOT}")
    args = parse_args()
    reexec_in_venv()
    if args.docker:
        run_docker(args)
        return
    py = ensure_venv(setup=args.setup or not venv_python().is_file())
    if not _is_venv_python(py):
        os.execv(str(py), [str(py), *sys.argv])
    ensure_backend(py, setup=args.setup or not package_importable(py))
    if args.dev:
        ensure_frontend(setup=args.setup or not (FRONTEND / "node_modules").is_dir())
        run_dev(args, py)
        return
    run_app(args, py)


if __name__ == "__main__":
    main()
