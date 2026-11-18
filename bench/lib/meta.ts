// What every results file says about where and with what it ran.
import { execFileSync } from "node:child_process";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { join } from "node:path";

const git = (...args: string[]) => {
  try {
    return execFileSync("git", args, { cwd: join(import.meta.dirname, "..", ".."), encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
};

export function benchMeta() {
  const dirty = git("status", "--porcelain", "--", "src").length > 0;
  return {
    date: new Date().toISOString(),
    node: process.version,
    agentStepsCommit: `${git("rev-parse", "--short", "HEAD")}${dirty ? "+dirty-src" : ""}`,
    machine: `${cpus()[0]?.model ?? "unknown cpu"}, ${cpus().length} cores, ${Math.round(totalmem() / 2 ** 30)} GB`,
    os: `${platform()} ${release()} ${arch()}`,
  };
}
