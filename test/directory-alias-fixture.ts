import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

/** Own temporary alias; never change an existing drive mapping. */
export async function withDirectoryAlias<T>(directory: string, check: (alias: string) => Promise<T> | T): Promise<T> {
  if (process.platform === "win32") {
    const drive = ["Z:", "Y:", "X:", "W:"].find((candidate) => !existsSync(`${candidate}\\`));
    if (!drive) throw new Error("No unused drive for alias regression");
    execFileSync("subst", [drive, directory]);
    try { return await check(`${drive}\\`); }
    finally { execFileSync("subst", [drive, "/D"]); }
  }
  const alias = join(dirname(directory), `alias-${randomUUID()}`);
  symlinkSync(directory, alias, "dir");
  try { return await check(alias); }
  finally { unlinkSync(alias); }
}
