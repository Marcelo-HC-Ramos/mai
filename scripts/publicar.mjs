// npm run publicar: atualiza as tabelas do banco (se houver novidade) e publica a versão nova do MAI.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ok = (m) => console.log(`\x1b[32m✔\x1b[0m ${m}`);
const fail = (m) => { console.error(`\x1b[31m✖ ${m}\x1b[0m`); process.exit(1); };
const wrangler = (args, input) => spawnSync("npx", ["wrangler", ...args], { shell: process.platform === "win32", encoding: "utf8", input,
  stdio: input !== undefined ? ["pipe", "pipe", "pipe"] : "inherit" });

if (readFileSync("wrangler.jsonc", "utf8").includes("PREENCHIDO_PELO_CONFIGURAR")) fail("Rode primeiro: npm run configurar");

const m = wrangler(["d1", "migrations", "apply", "mai", "--remote"], "y\n");
if (m.status !== 0) fail(`Não consegui atualizar as tabelas:\n${m.stdout}${m.stderr}`);
ok("Banco de dados atualizado");
if (wrangler(["deploy"]).status !== 0) fail("A publicação falhou (veja a mensagem acima).");
ok("MAI publicado em https://mai.ramosys.com.br  (confira com: npm run verificar)");
