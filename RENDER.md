# Colocar o MAI no ar com o Render (sem servidor, sem Docker)

Caminho recomendado. Você vai usar três sites, todos pelo navegador:

| Site | Para quê | Custo |
|---|---|---|
| MongoDB Atlas | banco de dados | grátis (até 512 MB) |
| Render | roda o sistema e cuida do HTTPS | cerca de US$ 7/mês (plano Starter) |
| Cloudflare | aponta mai.ramosys.com.br para o Render | grátis |

Tempo total: uns 30 minutos.

---

## Parte 1: banco de dados no MongoDB Atlas

1. Entre em https://www.mongodb.com/cloud/atlas/register e crie a conta (pode usar a conta Google).
2. Na tela **Deploy your cluster**, escolha **M0 (Free)**, provedor **AWS**, região **N. Virginia (us-east-1)**. Clique em **Create Deployment**.
3. Na janela que abre, crie o usuário do banco:
   - Username: `mai`
   - Password: clique em **Autogenerate Secure Password** e **copie a senha** para um bloco de notas.
   - Clique em **Create Database User**.
4. Clique em **Choose a connection method** → **Drivers**. Copie a linha que começa com `mongodb+srv://`.
   Ela parece com `mongodb+srv://mai:<db_password>@cluster0.abcde.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`.
5. No bloco de notas, troque `<db_password>` pela senha do passo 3. Essa linha completa é a sua **string de conexão**.
6. No menu da esquerda, vá em **Network Access** → **Add IP Address** → **Allow access from anywhere** (`0.0.0.0/0`) → **Confirm**.
   (O Render não tem IP fixo nesse plano; a senha do banco continua protegendo o acesso.)

---

## Parte 2: o sistema no Render

1. Entre em https://dashboard.render.com/register e crie a conta com **GitHub** (botão "GitHub"). Autorize o acesso ao repositório `mai`.
2. Abra este link, que já lê a configuração do projeto (`render.yaml`):

   **https://render.com/deploy?repo=https://github.com/Marcelo-HC-Ramos/mai**

3. Dê um nome ao Blueprint (ex.: `mai`). O Render vai pedir alguns valores:
   - **MAI_MONGO_URI**: cole a string de conexão da Parte 1.
   - **ML_CLIENT_ID**, **ML_CLIENT_SECRET**, **GEMINI_API_KEY**: deixe em branco por enquanto.
4. Clique em **Apply**. Cadastre o cartão quando pedir (plano Starter).
5. Espere o status ficar **Live** (a primeira publicação leva uns 5 minutos).
6. No topo da página do serviço aparece um endereço como `https://mai-xxxx.onrender.com`. Abra e confira se a tela de login aparece.

As senhas internas (`MAI_SECRET_KEY` e `MAI_ENCRYPTION_KEY`) são geradas pelo Render sozinho.
**Não altere a `MAI_ENCRYPTION_KEY` depois**: as contas do Mercado Livre conectadas ficariam ilegíveis.

---

## Parte 3: ligar mai.ramosys.com.br no Cloudflare

O MAI fica num subdomínio, então o site principal ramosys.com.br continua como está.

1. No Render, abra o serviço **mai** → **Settings** → **Custom Domains**. O domínio `mai.ramosys.com.br` já está listado.
   Anote o destino que ele mostra (o endereço `mai-xxxx.onrender.com`).
2. No Cloudflare (https://dash.cloudflare.com → ramosys.com.br → **DNS** → **Records**), clique em **Add record**:
   - Type: **CNAME**
   - Name: `mai`
   - Target: `mai-xxxx.onrender.com` (o seu, do passo 1)
   - Proxy status: **DNS only** (nuvem cinza)
   - **Save**.
3. Volte ao Render e clique em **Verify** ao lado do domínio. Em alguns minutos aparece **Certificate Issued**.
4. Abra **https://mai.ramosys.com.br**. Pronto.
5. (Opcional) Depois que o certificado sair, você pode ligar a nuvem laranja (**Proxied**) no Cloudflare. Se fizer
   isso, em **SSL/TLS → Overview** escolha **Full (strict)**.

---

## Parte 4: primeiro acesso

1. Em https://mai.ramosys.com.br clique em **Criar conta da empresa** e cadastre a sua empresa. Você vira o dono da conta.
2. Seus clientes fazem o mesmo: cada um cria a conta da própria empresa e só enxerga os próprios dados.

Enquanto o Mercado Livre não estiver conectado (Parte 6), o sistema usa dados de demonstração.

---

## Parte 5: atualizar o sistema

Toda alteração enviada para a branch `main` do GitHub é publicada sozinha pelo Render, para todos os clientes.
Para acompanhar, veja a aba **Events** do serviço. Os erros aparecem na aba **Logs**.

As tarefas automáticas (monitoramento de anúncios às 05:30, varredura diária às 06:00 e sincronização a cada
15 minutos, horários UTC) rodam dentro do próprio serviço (`MAI_SCHEDULER=1`), sem Redis.

---

## Parte 6 (depois): Mercado Livre e Gemini

**Mercado Livre**
1. Crie o aplicativo em https://developers.mercadolivre.com.br/devcenter.
   URL de redirecionamento: `https://mai.ramosys.com.br/auth/mercadolivre/callback`
2. No Render, serviço **mai** → **Environment**, preencha `ML_CLIENT_ID` e `ML_CLIENT_SECRET` e troque
   `MAI_CONNECTOR` de `demo` para `mercadolivre`. Clique em **Save Changes** (o Render publica de novo).

**Gemini (IA, opcional e grátis)**
1. Gere a chave em https://aistudio.google.com/apikey.
2. No Render, em **Environment**, preencha `GEMINI_API_KEY` e salve.

---

## Problemas comuns

| O que aparece | O que fazer |
|---|---|
| Publicação falha com erro de conexão ao banco | Confira a senha na `MAI_MONGO_URI` e o `0.0.0.0/0` em Network Access no Atlas |
| mai.ramosys.com.br não abre | Espere até 30 min pelo DNS; confira o CNAME e se a nuvem está cinza até o certificado sair |
| Erro de certificado com nuvem laranja | Cloudflare → SSL/TLS → **Full (strict)** |
| Todo mundo foi deslogado | Normal após mudar `MAI_SECRET_KEY`; basta entrar de novo |
