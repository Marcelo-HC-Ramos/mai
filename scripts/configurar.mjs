// npm run configurar: prepara a conta da Cloudflare para o MAI. Pode rodar quantas vezes quiser.
//
//   1. confere o login na Cloudflare (abre o navegador se precisar)
//   2. cria o banco D1 "mai" e grava o id dele no wrangler.jsonc
//   3. cria as tabelas e publica o MAI em https://mai.ramosys.com.br
//   4. cria as chaves secretas (só as que ainda não existem; as que já existem nunca são trocadas)
//   5. pergunta, se você quiser, a chave do Gemini e os dados do aplicativo do Mercado Livre
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

const CONFIG = "wrangler.jsonc";
const PLACEHOLDER = "PREENCHIDO_PELO_CONFIGURAR";
const SITE = "https://mai.ramosys.com.br";

const ok = (m) => console.log(`\x1b[32m✔\x1b[0m ${m}`);
const info = (m) => console.log(`\x1b[36m›\x1b[0m ${m}`);
const fail = (m) => { console.error(`\x1b[31m✖ ${m}\x1b[0m`); process.exit(1); };

function wrangler(args, { capture = false, input } = {}) {
  const r = spawnSync("npx", ["wrangler", ...args], { shell: process.platform === "win32", encoding: "utf8", input,
    stdio: capture || input !== undefined ? ["pipe", "pipe", "pipe"] : "inherit" });
  return { code: r.status ?? 1, out: (r.stdout || "") + (r.stderr || "") };
}

function jsonFrom(text) {
  const start = text.search(/[[{]/);
  if (start < 0) return null;
  try { return JSON.parse(text.slice(start)); } catch { return null; }
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = async (q) => (await rl.question(q)).trim();

console.log("\nConfigurando o MAI na Cloudflare (plano grátis)\n");

// 1. Login
if (!/You are logged in|associated with the email/i.test(wrangler(["whoami"], { capture: true }).out)) {
  info("Vou abrir o navegador para você entrar na Cloudflare. Clique em \"Allow\" e volte para esta janela.");
  if (wrangler(["login"]).code !== 0) fail("Não consegui entrar na Cloudflare. Rode de novo: npm run configurar");
}
ok("Conectado à Cloudflare");

// 2. Banco D1
let config = readFileSync(CONFIG, "utf8");
if (config.includes(PLACEHOLDER)) {
  const findDb = () => (jsonFrom(wrangler(["d1", "list", "--json"], { capture: true }).out) || []).find((d) => d.name === "mai");
  let db = findDb();
  if (!db) {
    info("Criando o banco de dados \"mai\"...");
    const created = wrangler(["d1", "create", "mai"], { capture: true });
    if (created.code !== 0 && !/already exists/i.test(created.out)) fail(`Não consegui criar o banco:\n${created.out}`);
    db = findDb();
  }
  const id = db?.uuid || db?.id;
  if (!id) fail("Não encontrei o id do banco \"mai\". Veja em https://dash.cloudflare.com > Storage & Databases > D1.");
  config = config.replace(PLACEHOLDER, id);
  writeFileSync(CONFIG, config);
  ok(`Banco de dados pronto (${id})`);
} else ok("Banco de dados já configurado");

// 3. Tabelas e publicação
info("Criando as tabelas no banco...");
const migr = wrangler(["d1", "migrations", "apply", "mai", "--remote"], { input: "y\n" });
if (migr.code !== 0) fail(`Não consegui criar as tabelas:\n${migr.out}`);
ok("Tabelas criadas");
info("Publicando o MAI...");
const deploy = wrangler(["deploy"], { capture: true });
process.stdout.write(deploy.out.split("\n").filter((l) => /Uploaded|Deployed|https:\/\/|mai\.ramosys/.test(l)).join("\n") + "\n");
if (deploy.code !== 0) {
  if (/already has|externally managed|override_existing|already exists/i.test(deploy.out)) {
    fail("O endereço mai.ramosys.com.br já tem um registro DNS antigo.\n" +
      "  Abra https://dash.cloudflare.com > ramosys.com.br > DNS > Records, apague o registro \"mai\" e rode de novo: npm run configurar");
  }
  fail(`A publicação falhou:\n${deploy.out}`);
}
ok(`MAI publicado em ${SITE}`);

// 4. Chaves secretas
const existing = new Set((jsonFrom(wrangler(["secret", "list", "--format", "json"], { capture: true }).out) || []).map((s) => s.name));
const secrets = {};
if (!existing.has("MAI_SECRET_KEY")) secrets.MAI_SECRET_KEY = randomBytes(32).toString("base64url");
if (!existing.has("MAI_ENCRYPTION_KEY")) secrets.MAI_ENCRYPTION_KEY = randomBytes(32).toString("base64");

// 5. Opcionais
console.log("\nAgora três perguntas opcionais. Se não tiver a informação, só aperte Enter (dá para rodar este comando de novo depois).\n");
const gemini = await ask(`Chave do Gemini (Google AI Studio)${existing.has("GEMINI_API_KEY") ? " [já configurada]" : ""}: `);
if (gemini) secrets.GEMINI_API_KEY = gemini;
const mlId = await ask(`App ID do Mercado Livre${existing.has("ML_CLIENT_ID") ? " [já configurado]" : ""}: `);
if (mlId) {
  secrets.ML_CLIENT_ID = mlId;
  const mlSecret = await ask("Chave secreta (Secret Key) do Mercado Livre: ");
  if (mlSecret) secrets.ML_CLIENT_SECRET = mlSecret;
}
rl.close();

if (Object.keys(secrets).length) {
  const file = join(tmpdir(), `mai-segredos-${process.pid}.json`);
  writeFileSync(file, JSON.stringify(secrets));
  const r = wrangler(["secret", "bulk", file], { capture: true });
  unlinkSync(file);
  if (r.code !== 0) fail(`Não consegui gravar as chaves secretas:\n${r.out}`);
  ok(`Chaves gravadas: ${Object.keys(secrets).join(", ")}`);
} else ok("Chaves secretas já estavam configuradas");

// Chaves para rodar no próprio computador (npm run dev); o arquivo não vai para o GitHub
if (!existsSync(".dev.vars")) {
  writeFileSync(".dev.vars", `MAI_SECRET_KEY=${randomBytes(32).toString("base64url")}\nMAI_ENCRYPTION_KEY=${randomBytes(32).toString("base64")}\n`);
}

console.log(`\nPronto! Abra ${SITE} e clique em "Criar conta" para cadastrar a sua empresa.`);
console.log("Para conferir se está tudo no ar: npm run verificar\n");
