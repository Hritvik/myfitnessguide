// Creates the gitignored deployment configs from their committed templates
// when they are missing, so a fresh clone can run the test suite.
//
// The real files hold account-specific identifiers (D1 database id, Access
// team domain and AUD, service-token client ids, OAuth KV namespace id) and
// are never committed. `npm run deploy` still reads the local files, so fill
// them in before deploying: see ../ACCESS.md ("Local configuration").
import { copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..");
const names = ["wrangler.jsonc"];

for (const name of names) {
  const real = join(dir, name);
  if (existsSync(real)) continue;
  const template = name.replace(/\.jsonc$/, ".example.jsonc");
  copyFileSync(join(dir, template), real);
  console.log(`created app/worker/${name} from ${template} (placeholder values)`);
}
