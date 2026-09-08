import { runCli } from "./index.js";

try {
  process.stdout.write(`${runCli(process.argv.slice(2))}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
