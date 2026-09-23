import process from "node:process";
import { run } from "../index.js";

process.exit(
  await run(process.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
  }),
);
