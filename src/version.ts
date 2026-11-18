// The package's version, read from its own package.json so it is written in one place.
import { readFileSync } from "node:fs";

const read = (): string => {
  try {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
};

export const VERSION = read();
/** The MCP protocol revision this package speaks, as a client and as a server. */
export const MCP_PROTOCOL = "2024-11-05";
