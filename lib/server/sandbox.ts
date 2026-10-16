import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export type SandboxResult = { code: number; stdout: string; stderr: string };

const OUTPUT_CAP = 100_000;

/**
 * Run a shell command with the document folder as its whole machine.
 * The process can read system libraries so Python works, and it can write
 * only inside the folder. The document file and git history are read-only,
 * there is no network, and the rest of the disk is not mounted.
 */
export async function runInFolder(folder: string, command: string, timeoutMs: number): Promise<SandboxResult> {
  const scratch = path.join(folder, ".tmp");
  await mkdir(scratch, { recursive: true });
  const script = path.join(scratch, "cmd.sh");
  await writeFile(script, `#!/bin/bash\n${command}\n`, { mode: 0o700 });
  try {
    if (process.platform === "linux") return await runLinux(folder, timeoutMs);
    if (process.platform === "darwin") return await runMac(folder, timeoutMs);
    throw new Error("Running commands needs a sandbox, and this computer doesn't have one Inline can use.");
  } finally {
    await rm(script, { force: true });
  }
}

async function runLinux(folder: string, timeoutMs: number): Promise<SandboxResult> {
  const setup = `
set -eu
WS="$1"
root=$(mktemp -d)
mount --bind "$root" "$root"
mkdir -p "$root/work" "$root/tmp" "$root/proc" "$root/dev" "$root/bin" "$root/usr" "$root/lib" "$root/lib64" "$root/etc" "$root/oldroot"
bind_ro() {
  [ -e "$1" ] || return 0
  mkdir -p "$2"
  mount --bind "$1" "$2"
  mount -o remount,bind,ro "$2"
}
bind_ro /usr "$root/usr"
bind_ro /bin "$root/bin"
bind_ro /lib "$root/lib"
if [ -d /lib64 ]; then bind_ro /lib64 "$root/lib64"; fi
printf 'root:x:0:0:root:/work:/bin/sh\\n' > "$root/etc/passwd"
printf 'root:x:0:\\n' > "$root/etc/group"
mount -t tmpfs -o size=64m tmpfs "$root/tmp"
for dev in null zero urandom random; do
  if [ -e "/dev/$dev" ]; then
    touch "$root/dev/$dev"
    mount --bind "/dev/$dev" "$root/dev/$dev"
  fi
done
mount --bind "$WS" "$root/work"
protect() {
  [ -e "$root/work/$1" ] || return 0
  mount --bind "$root/work/$1" "$root/work/$1"
  mount -o remount,bind,ro "$root/work/$1"
}
protect .git
protect document.json
protect .draft
cd "$root"
if [ -x /usr/sbin/pivot_root ]; then
  /usr/sbin/pivot_root . oldroot
elif [ -x /sbin/pivot_root ]; then
  /sbin/pivot_root . oldroot
else
  echo "pivot_root is not available" >&2
  exit 97
fi
mount -t proc proc /proc
umount -l /oldroot 2>/dev/null || true
if [ -d /oldroot/home ] || [ -d /oldroot/usr ]; then
  echo "sandbox failed to detach from the machine" >&2
  exit 97
fi
rmdir /oldroot 2>/dev/null || true
cd /work
export PATH="/usr/bin:/bin" HOME=/work TMPDIR=/tmp LANG=C.UTF-8 LC_ALL=C.UTF-8 PYTHONDONTWRITEBYTECODE=1
set +e
bash /work/.tmp/cmd.sh
exit $?
`;
  return capture("unshare", ["--user", "--map-root-user", "--mount", "--net", "--fork", "--pid", "--mount-proc", "bash", "-s", "--", folder], setup, timeoutMs);
}

async function runMac(folder: string, timeoutMs: number): Promise<SandboxResult> {
  const profile = `
(version 1)
(deny default)
(allow process*)
(allow signal)
(allow sysctl-read)
(allow file-ioctl)
(allow file-read* (subpath "/usr") (subpath "/bin") (subpath "/opt/homebrew") (subpath "/Library") (subpath "/System") (subpath "/dev") (subpath "/private/var/select") (literal "/private/etc/passwd") (literal "/private/etc/group"))
(allow file-read* (subpath ${plist(folder)}))
(allow file-write* (subpath ${plist(folder)}))
(deny file-write* (subpath ${plist(path.join(folder, ".git"))}) (literal ${plist(path.join(folder, "document.json"))}) (subpath ${plist(path.join(folder, ".draft"))}))
(deny network*)
`;
  return capture("sandbox-exec", ["-p", profile, "bash", path.join(folder, ".tmp", "cmd.sh")], "", timeoutMs, {
    cwd: folder,
    env: {
      ...process.env,
      PATH: "/usr/bin:/bin:/opt/homebrew/bin",
      HOME: folder,
      TMPDIR: path.join(folder, ".tmp"),
      LANG: "C.UTF-8",
      PYTHONDONTWRITEBYTECODE: "1",
    },
  });
}

function plist(value: string) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function capture(
  command: string,
  args: string[],
  input: string,
  timeoutMs: number,
  extra: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<SandboxResult> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: extra.cwd,
        env: extra.env ?? { ...process.env, PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      reject(error);
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    child.stdout?.on("data", (chunk: Buffer) => {
      if (outBytes < 1_000_000) {
        stdout.push(chunk);
        outBytes += chunk.length;
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (errBytes < 1_000_000) {
        stderr.push(chunk);
        errBytes += chunk.length;
      }
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") reject(new Error("Running commands needs a sandbox, and this computer doesn't have one Inline can use."));
      else reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const out = Buffer.concat(stdout).toString("utf8");
      const err = Buffer.concat(stderr).toString("utf8");
      if (signal === "SIGKILL") {
        resolve({ code: 124, stdout: clip(out), stderr: clip(`${err}\nThe command was stopped because it ran too long or wrote too much.`) });
        return;
      }
      resolve({ code: code ?? 1, stdout: clip(out), stderr: clip(err) });
    });
    child.stdin?.end(input);
  });
}

function clip(text: string) {
  const value = String(text ?? "");
  return value.length > OUTPUT_CAP ? `${value.slice(0, OUTPUT_CAP)}\n…[output truncated]` : value;
}
