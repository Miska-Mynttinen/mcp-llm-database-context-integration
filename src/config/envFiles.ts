import { ENV_FILES, loadEnvFiles } from '@mcp-llm/runtime';

/**
 * Loads `.env.llm`, `.env.database`, `.env.mcp`, `.env.limits` and `.env` from `dir` into `process.env`,
 * skipping missing files. Precedence: real environment variables, then the
 * first file that defines a variable (so `.env` only fills gaps).
 * Returns the paths of the files that were loaded.
 */
export function loadConfigEnvFiles(dir: string = process.cwd()): string[] {
  return loadEnvFiles(dir, [ENV_FILES.llm, ENV_FILES.database, ENV_FILES.mcp, ENV_FILES.limits, ENV_FILES.app]);
}
