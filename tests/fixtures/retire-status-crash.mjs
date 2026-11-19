// Test-only failure injection: stop the real CLI immediately after its atomic role.yaml rename publishes retired status.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const rename = fs.renameSync;
fs.renameSync = (...args) => {
  if (args[1] === process.env.FLUME_TEST_RETIRE_ROLE && process.env.FLUME_TEST_RETIRE_BEFORE_STATUS === "1"
      && /^  status: "retired"$/m.test(fs.readFileSync(args[0], "utf8"))) process.exit(88);
  const result = rename(...args);
  if (args[1] === process.env.FLUME_TEST_RETIRE_ROLE && /^  status: "retired"$/m.test(fs.readFileSync(args[1], "utf8"))) process.exit(87);
  return result;
};
syncBuiltinESMExports();
