// npm run verificar: confere se o MAI está no ar em https://mai.ramosys.com.br
const SITE = "https://mai.ramosys.com.br";
const ok = (m) => console.log(`\x1b[32m✔\x1b[0m ${m}`);
const bad = (m) => console.log(`\x1b[31m✖\x1b[0m ${m}`);

let fine = true;
try {
  const r = await fetch(`${SITE}/healthz`);
  const body = await r.json().catch(() => ({}));
  if (r.ok && body.ok) ok("Servidor e banco de dados respondendo");
  else { fine = false; bad(`O servidor respondeu ${r.status}. Rode: npm run logs  (e me mande o que aparecer)`); }
} catch (e) {
  fine = false;
  bad(`Não consegui abrir ${SITE}: ${e.message}`);
  console.log("  Se acabou de publicar, espere uns minutos (o certificado do endereço pode demorar) e rode de novo.");
}
try {
  const r = await fetch(SITE);
  const html = await r.text();
  if (r.ok && html.includes("MAI")) ok("Telas carregando");
  else { fine = false; bad(`A página inicial respondeu ${r.status}`); }
} catch { /* já avisado acima */ }
try {
  const r = await fetch(`${SITE}/api/me`);
  if (r.status === 401) ok("Login exigido nas rotas protegidas");
  else { fine = false; bad(`/api/me deveria pedir login e respondeu ${r.status}`); }
} catch { /* já avisado acima */ }
console.log(fine ? `\nTudo certo. Acesse ${SITE}\n` : "\nAlgo não está certo; veja as mensagens acima.\n");
process.exit(fine ? 0 : 1);
