import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";

const ALIASES_PATH = resolve(homedir(), ".config", "messaging", "aliases.json");

export function readAliases(): Map<string, string> {
  try {
    if (!existsSync(ALIASES_PATH)) return new Map();
    const raw = readFileSync(ALIASES_PATH, "utf-8");
    const obj = JSON.parse(raw) as Record<string, string>;
    const map = new Map<string, string>();
    for (const [aliasName, sessionId] of Object.entries(obj)) {
      if (typeof sessionId === "string" && sessionId.trim()) {
        map.set(aliasName, sessionId.trim());
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

export function writeAlias(sessionId: string, alias: string): void {
  const aliases = readAliases();
  aliases.set(alias, sessionId);
  const obj: Record<string, string> = {};
  for (const [k, v] of aliases) {
    obj[k] = v;
  }
  mkdirSync(dirname(ALIASES_PATH), { recursive: true });
  writeFileSync(ALIASES_PATH, JSON.stringify(obj, null, 2) + "\n", "utf-8");
}

export function removeAlias(sessionId: string): void {
  const aliases = readAliases();
  let changed = false;
  for (const [aliasName, sid] of aliases) {
    if (sid === sessionId) {
      aliases.delete(aliasName);
      changed = true;
    }
  }
  if (!changed) return;
  const obj: Record<string, string> = {};
  for (const [k, v] of aliases) {
    obj[k] = v;
  }
  mkdirSync(dirname(ALIASES_PATH), { recursive: true });
  writeFileSync(ALIASES_PATH, JSON.stringify(obj, null, 2) + "\n", "utf-8");
}

export function resolveAlias(input: string, aliases?: Map<string, string>): string {
  const map = aliases ?? readAliases();
  if (map.has(input)) return map.get(input)!;
  return input;
}

export function reverseAliasLookup(sessionId: string, aliases?: Map<string, string>): string | undefined {
  const map = aliases ?? readAliases();
  for (const [aliasName, sid] of map) {
    if (sid === sessionId) return aliasName;
  }
  return undefined;
}
