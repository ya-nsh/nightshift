import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TEMPLATE_NAMES = [
  "implement",
  "address",
  "fix-checks",
  "resolve-conflicts",
  "finalize",
  "issue",
  "finalize-issue",
  "answer",
  "restarted",
  "lane",
  "finalize-lanes",
  "plan",
] as const;
export type TemplateName = (typeof TEMPLATE_NAMES)[number];

/** Default prompts shipped with the package (`<package>/prompts`, one level above src/ and dist/). */
export const DEFAULT_PROMPTS_DIR = fileURLToPath(new URL("../prompts/", import.meta.url));

export type Templates = Record<TemplateName, string>;

/** Loads every template, preferring `overrideDir/<name>.md` when it exists. */
export async function loadTemplates(overrideDir: string | undefined): Promise<Templates> {
  const entries = await Promise.all(
    TEMPLATE_NAMES.map(async (name) => {
      const file = `${name}.md`;
      if (overrideDir) {
        try {
          return [name, await readFile(path.join(overrideDir, file), "utf8")] as const;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      return [name, await readFile(path.join(DEFAULT_PROMPTS_DIR, file), "utf8")] as const;
    }),
  );
  return Object.fromEntries(entries) as Templates;
}

/**
 * Replaces `{{name}}` placeholders. An unknown placeholder is an error rather than an empty string,
 * so a typo in a custom template cannot silently drop context from a prompt.
 */
export function render(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_match, name: string) => {
    const value = vars[name];
    if (value === undefined) {
      throw new Error(
        `unknown placeholder {{${name}}}; available: ${Object.keys(vars).join(", ")}`,
      );
    }
    return String(value);
  });
}
