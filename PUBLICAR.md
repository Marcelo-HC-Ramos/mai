# Como colocar o MAI no ar (grátis, na Cloudflare)

O MAI roda na Cloudflare, do mesmo jeito que o Agente de Anúncios: plano grátis, sempre ligado, sem servidor para
cuidar e sem pagar nada. O endereço é **https://mai.ramosys.com.br**.

Você vai digitar cinco comandos, uma vez só. Depois, para atualizar, são dois.

## Antes de começar

Você já tem tudo isso por causa do Agente de Anúncios:

- **Node.js** instalado (confira abrindo o terminal e digitando `node -v`; deve aparecer um número como `v22...`).
- **Git** instalado (`git --version`).
- A **conta da Cloudflare** onde está o domínio ramosys.com.br.

> Terminal é o "Prompt de Comando" ou o "PowerShell" no Windows, ou o "Terminal" no Mac.

## Passo 1: baixar o MAI para o seu computador

No terminal, entre na pasta onde ficam seus projetos (a mesma do Agente de Anúncios, por exemplo) e rode:

```
git clone https://github.com/Marcelo-HC-Ramos/mai.git
cd mai
```

Se você já tinha baixado a pasta `mai` antes, não precisa baixar de novo: entre nela e rode `git pull`.

## Passo 2: instalar as ferramentas

```
npm install
```

Demora um ou dois minutos. Avisos amarelos podem ser ignorados.

## Passo 3: configurar e publicar

```
npm run configurar
```

Esse comando faz tudo sozinho:

1. Abre o navegador para você entrar na Cloudflare. Clique em **Allow** e volte para o terminal.
2. Cria o banco de dados do MAI na sua conta.
3. Publica o MAI em https://mai.ramosys.com.br (o endereço é criado automaticamente).
4. Cria as chaves de segurança.
5. Faz três perguntas opcionais: a chave do Gemini e os dois dados do aplicativo do Mercado Livre. **Se não tiver
   agora, só aperte Enter.** Você pode rodar `npm run configurar` de novo quando tiver.

> **Se aparecer "o endereço mai.ramosys.com.br já tem um registro DNS antigo":** abra
> https://dash.cloudflare.com, clique em **ramosys.com.br**, depois em **DNS** > **Records**, apague a linha com o
> nome **mai** e rode `npm run configurar` de novo. (Ela foi criada no guia antigo do Render.)

## Passo 4: conferir

```
npm run verificar
```

Tem que aparecer três linhas verdes ✔. Se o endereço ainda não abrir, espere uns 5 minutos (a Cloudflare está
preparando o cadeado de segurança do endereço) e rode de novo.

## Passo 5: usar

1. Abra **https://mai.ramosys.com.br** e clique em **Criar conta da empresa**.
2. Para conhecer o sistema sem mexer na sua loja de verdade: aba **Contas** > **Adicionar conta de demonstração**.
   Aparecem produtos, vendas e perguntas de mentira para você testar todas as telas.
3. Cada cliente seu faz o mesmo: entra no endereço e cria a conta da empresa dele. Uma empresa nunca vê os dados da
   outra.

## Para atualizar depois

Sempre que houver uma versão nova no GitHub:

```
git pull
npm run publicar
```

## Ligar o Mercado Livre de verdade

1. Entre em https://developers.mercadolivre.com.br/devcenter e crie um aplicativo (ou edite o que você já tem).
2. Em **URI de redirect**, coloque: `https://mai.ramosys.com.br/auth/mercadolivre/callback`
3. Em **Notificações**, coloque a URL `https://mai.ramosys.com.br/webhooks/mercadolivre` e marque os tópicos
   **orders_v2**, **questions** e **items**.
4. Copie o **App ID** e a **Secret Key** do aplicativo.
5. No terminal, dentro da pasta `mai`, rode `npm run configurar` e cole os dois quando ele perguntar.
6. No MAI, aba **Contas** > **Conectar conta do Mercado Livre**. Dá para conectar mais de uma conta na mesma loja.

## Ligar a IA grátis (Gemini)

1. Pegue uma chave em https://aistudio.google.com/apikey (é grátis).
2. Rode `npm run configurar` e cole a chave quando ele perguntar.

Cada cliente também pode colocar a chave dele em **Configurações**, dentro do MAI.

## O que roda sozinho

- A cada 15 minutos: pedidos e perguntas novas das contas do Mercado Livre.
- Todo dia a partir das 02:30 (horário de Brasília): uma foto de preço e vendas dos anúncios monitorados.
- Todo dia a partir das 03:00 (horário de Brasília): uma análise de mercado nova de cada produto.

## É grátis mesmo?

Sim. O plano grátis da Cloudflare permite 100 mil acessos por dia e 5 GB de banco de dados, muito mais do que o MAI
usa com dezenas de lojas. Se um dia passar do limite, a Cloudflare só para de responder até o dia seguinte; ela não
cobra nada sem você mudar de plano.

## Se algo der errado

- `npm run logs` mostra, ao vivo, o que está acontecendo no MAI. Deixe aberto, use o site e me mande o que aparecer.
- `npm run verificar` diz se o site, o banco e o login estão funcionando.
- Erro de login na Cloudflare: rode `npx wrangler login` e depois o comando de novo.
