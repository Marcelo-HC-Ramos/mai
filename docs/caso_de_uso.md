# MAI: Especificação por Casos de Uso

Este documento detalha o comportamento do sistema MAI a partir dos casos de uso. Ele complementa o
"Documento de Especificação de Requisitos e Arquitetura de Software" do projeto (UC01 a UC05, RF01 a RF08,
RNF01 a RNF04) e acrescenta os casos de uso necessários para cobrir os cinco critérios de análise de mercado
pedidos pelo cliente. Cada caso de uso termina com a rastreabilidade para o código em `src/`.

## 1. Atores

| Ator | Descrição |
|---|---|
| Empresa cliente | Organização que contrata o MAI. Tem uma ou mais lojas, cada loja com uma ou mais contas de marketplace. |
| Dono / Administrador | Usuário da empresa que cadastra lojas, conecta contas, convida usuários e configura a IA. |
| Vendedor (Analista) | Usuário da empresa que consulta relatórios e painéis, roda análises e responde perguntas. |
| Analista de E-commerce | Usa relatórios históricos para decisões de catálogo, margem e compras. |
| Agente MAI | Processo automatizado (Cloudflare Worker) que varre o mercado, analisa e grava os resultados no banco D1. |
| Serviço de IA | API Gemini (camada gratuita do Google AI Studio), usada para classificar avaliações, sugerir respostas e resumir o relatório. Opcional. |
| Agendador | Cron Trigger da Cloudflare (a cada 15 minutos), dispara sincronizações, fotos e varreduras sem intervenção humana. |
| Marketplace | Sistema externo (Mercado Livre na primeira versão) acessado via API oficial e webhooks. |

## 2. Diagrama de casos de uso

```
                         +-------------------------------------------------+
                         |                     MAI                         |
   Visitante ----------->|  UC12 Cadastrar empresa e entrar no sistema     |
   Administrador ------->|  UC13 Gerenciar usuários e configurações       |
   Administrador ------->|  UC01 Conectar contas do marketplace (1..N)    |<----- Marketplace
      |  \               |  UC02 Executar varredura de mercado (agente)    |         (API/Webhook)
      |   \------------->|    <<include>> UC06 Analisar preços concorrentes|
      |                  |    <<include>> UC07 Identificar palavras-chave  |
   Agendador ----------->|    <<include>> UC08 Estimar celular x computador|
                         |    <<include>> UC09 Diagnosticar aval. ruins    |
                         |    <<include>> UC10 Recomendar melhor preço     |
   Vendedor ------------>|  UC03 Gerar relatório de mercado               |
   Vendedor ------------>|  UC04 Dashboard de vendas e faturamento         |
   Vendedor ------------>|  UC05 Central de perguntas dos anúncios         |
   Vendedor ------------>|  UC11 Acompanhar estoque                        |
   Vendedor ------------>|  UC14 Calcular custos e lucro do produto        |
   Vendedor ------------>|  UC15 Raio-x de anúncio (próprio ou concorrente)|
   Vendedor ------------>|  UC16 Pesquisa de mercado por termo            |
   Vendedor/Agendador -->|  UC17 Monitorar anúncios de concorrentes        |
                         +-------------------------------------------------+
```

## 3. Regras de negócio globais

- **RN01 Transparência da fonte.** Todo número do relatório informa sua origem: `api` (dado oficial do
  marketplace), `calculado` (derivado de dados oficiais pelo MAI) ou `estimativa` (o marketplace não expõe o
  dado e o MAI usa uma referência externa ou do próprio vendedor). Estimativas aparecem marcadas no relatório.
- **RN02 Margem mínima.** Nenhuma recomendação de preço fica abaixo do maior valor entre o `min_selling_price`
  do produto e o preço que garante a margem mínima configurada (padrão 15% sobre o preço, após custo, comissão
  e tarifa fixa do marketplace).
- **RN03 Limpeza de outliers.** Preços de concorrentes passam por filtro de intervalo interquartil (IQR, fator
  1,5) antes do cálculo de estatísticas.
- **RN04 Credenciais.** Tokens de acesso ficam criptografados em repouso com AES-256-GCM (RNF02).
- **RN05 Limites de API.** Chamadas externas usam limitador de taxa e novas tentativas com backoff exponencial,
  respeitando o cabeçalho `Retry-After` (RNF01).
- **RN06 Avaliação ruim.** É ruim a avaliação com nota de 1 a 3 estrelas.
- **RN07 Isolamento entre empresas.** Todo dado de negócio (lojas, contas, produtos, pedidos, perguntas, análises)
  pertence a uma empresa (`org_id`). Um usuário só vê e altera dados da própria empresa; tentar acessar um dado de
  outra empresa responde "não encontrado".
- **RN08 Uma conta, uma empresa.** Uma conta de marketplace só pode estar conectada a uma empresa por vez. Uma loja
  pode ter várias contas, inclusive mais de uma no mesmo marketplace.
- **RN09 Papéis.** Dono e Administrador gerenciam lojas, contas, usuários e configurações; Analista consulta, roda
  análises e responde perguntas. Só o Dono cria ou altera outro Dono.
- **RN10 IA com alternativa.** Toda tarefa que usa IA tem uma alternativa por regras. Sem chave, com a IA desligada
  ou se a API falhar, o MAI usa as regras e o relatório informa qual método foi usado. Textos gerados por IA são
  marcados e precisam de revisão humana antes de ir ao comprador. Nenhum dado pessoal de comprador é enviado à IA.
- **RN11 Faturamento de concorrente é estimativa.** O marketplace não divulga quanto um anúncio faturou. O MAI
  estima por `vendidos × preço atual` (acumulado) e `vendidos ÷ idade do anúncio` (por mês), sempre marcado como
  `estimativa`. Quando o anúncio é monitorado (UC17) e há duas fotos com pelo menos um dia de intervalo, vendas e
  faturamento do período passam a `calculado`, pela diferença de vendidos entre as fotos. O Mercado Livre arredonda
  o total de vendidos em faixas para alguns anúncios, o que limita a precisão.
- **RN12 Modalidade de envio.** Todo anúncio carrega sua modalidade: `full` (Mercado Envios Full), `flex`
  (Mercado Envios Flex), `coleta` (coleta ou agência), `proprio` (envio por conta do vendedor) ou `desconhecido`.
  Vem do campo `shipping.logistic_type` da API (`fulfillment`, `self_service`, `cross_docking`/`drop_off`/
  `xd_drop_off`, `custom`/`not_specified`), com `source = "api"`.

---

## UC12 Cadastrar empresa e entrar no sistema

**Ator principal:** Visitante (futuro Dono). **Pós-condição:** empresa, usuário Dono e primeira loja criados.

**Fluxo principal**
1. O visitante clica em "Criar conta da empresa" e informa nome da empresa, seu nome, e-mail e senha.
2. O sistema valida que o e-mail não está em uso e que a senha tem pelo menos 8 caracteres.
3. O sistema cria a empresa, o usuário com papel Dono (senha guardada com PBKDF2) e uma loja com o nome da empresa.
4. O sistema abre uma sessão (token assinado, válido por 12 horas) e mostra o painel vazio, convidando a conectar uma conta (UC01).

**Fluxo alternativo:** 1a. Usuário já cadastrado entra com e-mail e senha e recebe o token de sessão.
**Exceções:** 2e. E-mail já cadastrado ou senha curta: mensagem de erro e nada é criado. 4e. Sessão expirada: o
sistema volta à tela de login.

**Rastreabilidade:** `src/auth.ts`, `src/api.ts` (`/api/auth/register`, `/api/auth/login`, `/api/me`).

---

## UC13 Gerenciar usuários e configurações da empresa

**Ator principal:** Dono ou Administrador (RN09).

**Fluxo principal**
1. O administrador abre "Equipe" e adiciona um usuário com nome, e-mail, senha inicial e papel (Analista ou Administrador).
2. O administrador pode desativar ou reativar usuários; um usuário desativado perde o acesso na hora.
3. Em "Configurações", define a margem mínima da empresa (RN02) e a IA: usar a chave do servidor, cadastrar a
   chave própria do Gemini (guardada criptografada, RN04) ou desligar a IA.
4. Em "Contas", cria novas lojas da empresa.

**Rastreabilidade:** `src/api.ts` (`/api/users`, `/api/org/settings`, `/api/sellers`).

---

## UC01 Conectar contas do marketplace (uma ou várias)

**Ator principal:** Dono ou Administrador. **Ator secundário:** Marketplace.
**Pré-condição:** a loja existe na empresa do usuário.
**Pós-condição:** conta `ACTIVE` gravada em `marketplace_accounts` com tokens criptografados; anúncios, pedidos e
perguntas daquela conta importados.

**Fluxo principal**
1. O administrador abre "Contas", escolhe a loja e clica em "Conectar conta do Mercado Livre".
2. O sistema gera um `state` de uso único (vale 15 minutos) ligado à empresa e à loja, e redireciona para a
   autorização OAuth 2.0 do marketplace.
3. O administrador entra com a conta desejada e concede as permissões.
4. O marketplace chama `/auth/mercadolivre/callback` com o `code` e o `state`.
5. O sistema troca o `code` pelos tokens, busca o apelido da conta, criptografa os tokens (RN04) e grava a conta.
6. O sistema importa anúncios e estoque, pedidos dos últimos 90 dias e perguntas da conta.
7. Para ligar outra conta (do mesmo ou de outro marketplace), o administrador repete o fluxo. Anúncios com o mesmo
   SKU em contas diferentes viram um único produto com vários anúncios.

**Fluxos alternativos**
- 3a. Permissão negada: volta para "Contas" com "Autorização cancelada".
- 5a. A conta já está ligada a esta empresa: os tokens são renovados, sem duplicar.
- 6a. O token expira durante a sincronização: o conector renova com o `refresh_token` e grava os novos tokens.
- 8. Desconectar: o administrador clica em "Desconectar"; os tokens são apagados, a conta fica `REVOKED` e o
  histórico continua disponível (RF01).

**Exceções**
- 5e. A conta já está ligada a outra empresa (RN08): nada é gravado e aparece "Esta conta já está ligada a outra empresa".
- 4e. `state` inválido ou expirado: a autorização é descartada.

**Rastreabilidade:** `src/api.ts` (`/api/sellers/{id}/accounts/...`, `/auth/mercadolivre/callback`),
`src/services.ts` (`connectAccount`, `disconnectAccount`), `src/security.ts`, `src/sync.ts`.

---

## UC02 Executar varredura de mercado (Agente MAI)

**Ator principal:** Vendedor ou Agendador. **Ator secundário:** Marketplace.
**Pré-condição:** o produto existe em `products` (com título e, de preferência, EAN e custo).
**Pós-condição:** um novo documento em `market_snapshots` com os cinco blocos de análise e as recomendações.

**Fluxo principal**
1. O vendedor clica em "Analisar mercado" num produto, ou o Agendador dispara a varredura diária.
2. O agente monta a consulta de busca (EAN quando existe, senão o título normalizado).
3. O agente consulta o marketplace e coleta os anúncios concorrentes (preço, frete grátis, vendidos, reputação, categoria).
4. O agente executa, nesta ordem, os casos de uso incluídos UC06, UC07, UC08, UC09 e UC10.
5. O agente gera as recomendações textuais (preço, título/SEO, mídia, pontos fortes a destacar).
6. Se a empresa tem IA disponível (RN10), o agente pede ao Gemini um resumo executivo, uma sugestão de título e três
   argumentos de venda baseados nas falhas dos concorrentes.
7. O agente grava o snapshot no banco D1 com data de captura, conta usada, empresa e a origem de cada dado (RN01).
8. O sistema avisa a interface que o relatório está pronto.

**Fluxos alternativos**
- 3a. Nenhum concorrente encontrado pelo EAN: o agente repete a busca pelo título.
- 3b. Menos de 3 concorrentes após a limpeza: o snapshot é gravado com `confidence = "baixa"` e o relatório avisa.
- 1a. O produto está em várias contas: o vendedor escolhe a conta no filtro do topo; sem escolha, usa a primeira conta ativa do produto.
- 4a. A plataforma não oferece um dos dados: o bloco correspondente é gravado com `source = "estimativa"` ou
  `source = "indisponivel"`, e a varredura continua.

**Exceções**
- 3e. Limite de requisições atingido: o conector espera e tenta de novo (RN05); depois de 5 falhas a varredura
  termina com status `FAILED` e o motivo.

**Rastreabilidade:** `src/agent.ts` (`MarketAgent.analyzeProduct`), `src/scheduler.ts`, `src/internal.ts`.

---

## UC06 Analisar preços dos concorrentes (incluído em UC02)

**Pergunta do vendedor:** "Quais os preços dos concorrentes?"

**Fluxo principal**
1. O agente recebe a lista de anúncios concorrentes, removendo os do próprio vendedor.
2. Aplica o filtro IQR (RN03) e registra quantos anúncios foram descartados.
3. Calcula menor, maior, média, mediana, quartis e desvio padrão; identifica o anúncio mais vendido e o menor
   preço com frete grátis.
4. Calcula a posição do preço atual do vendedor (percentil) e a diferença para a mediana e para o menor preço.

5. Agrupa os concorrentes por modalidade de envio (RN12) e mostra, para Full, Flex, coleta e envio próprio:
   quantidade de anúncios, participação nas vendas, preço mediano e média de vendidos; qual modalidade domina entre
   os 10 mais vendidos; e quanto o Full cobra a mais ou a menos que o resto do mercado.

**Parâmetro: modalidade de envio.** O vendedor pode limitar a comparação a uma ou mais modalidades (por exemplo,
"só quem está no Full" ou "Full e Flex"). Com o filtro, preços, recomendação de preço (UC10) e lista de concorrentes
consideram apenas essas modalidades; o quadro de logística do passo 5 continua mostrando o mercado inteiro, e o
relatório avisa que um filtro foi aplicado. Palavras-chave (UC07) e avaliações (UC09) usam sempre todos os
concorrentes, para não perder amostra.

**Saída:** bloco `competitor_data` com `source = "api"` para os preços e `calculado` para as estatísticas, mais a
lista dos 10 concorrentes mais relevantes (com a modalidade de envio de cada um) e o bloco `logistics`.

**Fluxo alternativo**
- 5a. O líder de vendas está no Full (50% ou mais dos 10 mais vendidos) e o vendedor não: o MAI recomenda avaliar o
  Full. Mesma regra para o Flex. Se o Full cobra mais caro que o mercado, a recomendação informa a diferença.

**Rastreabilidade:** `src/analysis/pricing.ts` (`competitorStats`, `removeOutliersIqr`),
`src/analysis/logistics.ts` (`logisticsInsights`, `filterByModes`), `src/analysis/recommendations.ts`.

---

## UC07 Identificar palavras-chave mais buscadas (incluído em UC02)

**Pergunta do vendedor:** "Quais as palavras-chave mais usadas pelos compradores para buscar o produto?"

**Fluxo principal**
1. O agente consulta as tendências de busca da categoria do produto (`/trends/{site}/{categoria}`, buscas com
   maior crescimento, mais desejadas e mais populares da semana).
2. Filtra os termos relacionados ao produto (compartilham pelo menos uma palavra relevante com o título).
3. Extrai termos e expressões de 2 e 3 palavras dos títulos dos concorrentes, ponderados pela quantidade vendida
   de cada anúncio.
4. Combina as duas fontes numa pontuação de 0 a 100 e ordena.
5. Compara com o título do vendedor e lista os termos fortes que ele ainda não usa.

**Regra:** o Mercado Livre não divulga volume absoluto de buscas, então a pontuação é **relativa**. Quando o
vendedor conectar uma fonte de volume (por exemplo, planilha de Google Keyword Planner ou relatório de Mercado Ads),
o volume é mostrado com `source = "vendedor"`.

**Rastreabilidade:** `src/analysis/keywords.ts`.

---

## UC08 Estimar buscas por celular x computador (incluído em UC02)

**Pergunta do vendedor:** "As pessoas buscam mais esse produto pelo celular ou pelo computador?"

**Fluxo principal**
1. O agente procura dados de dispositivo fornecidos pelo vendedor (relatório de tráfego importado, por exemplo
   do Google Analytics da loja própria ou do Mercado Ads). Se houver, usa com `source = "vendedor"`.
2. Sem dados do vendedor, usa a referência de mercado por categoria configurada em `src/analysis/devices.ts`, com
   `source = "estimativa"` e o nome da referência.
3. Gera a recomendação de mídia correspondente (por exemplo, foto principal legível em tela pequena quando o
   celular passa de 60%).

**Regra:** a API do Mercado Livre não informa o dispositivo de quem busca. O relatório sempre mostra de onde veio o
número, e a tabela de referência pode ser atualizada pelo administrador.

**Rastreabilidade:** `src/analysis/devices.ts`.

---

## UC09 Diagnosticar o principal motivo das avaliações ruins (incluído em UC02)

**Pergunta do vendedor:** "Qual é o principal motivo das avaliações ruins?"

**Fluxo principal**
1. O agente busca as avaliações dos concorrentes mais vendidos (`/reviews/item/{id}`) e, se houver, as do próprio
   anúncio do vendedor.
2. Seleciona as avaliações de 1 a 3 estrelas (RN06).
3. Classifica cada texto em motivos (pelo Gemini quando disponível, senão por palavras-chave, RN10): qualidade/defeito, durabilidade, entrega/atraso, embalagem/avaria, produto
   diferente do anúncio, tamanho/medida, compatibilidade, bateria/carregamento, peças faltando, atendimento,
   custo-benefício. Um texto pode ter mais de um motivo.
4. Conta os motivos, calcula o percentual e separa até 3 trechos de exemplo por motivo.
5. Aponta o principal motivo do mercado e, separadamente, o do próprio vendedor.

**Fluxo alternativo**
- 2a. Menos de 5 avaliações ruins: o relatório mostra o resultado com aviso de amostra pequena.

**Rastreabilidade:** `src/analysis/reviews.ts`.

---

## UC10 Recomendar o melhor preço de venda (incluído em UC02)

**Pergunta do vendedor:** "Qual é o melhor preço para vender?"

**Fluxo principal**
1. O agente lê custo, preço mínimo e o perfil de custos da loja (UC14): comissão do tipo de anúncio, tarifa fixa,
   frete da modalidade de envio do anúncio, impostos, Mercado Ads e embalagem.
2. Gera preços candidatos entre o primeiro quartil e o terceiro quartil do mercado, em passos de R$ 0,10 e com
   final ",90".
3. Para cada candidato, estima a chance relativa de conversão pela posição em relação à mediana (curva logística,
   mais sensível quando há muitos concorrentes) e calcula o lucro esperado: (preço - todos os custos da UC14) ×
   conversão. Se o filtro de modalidade (UC06) estiver ativo, o mercado de referência é só o filtrado.
4. Descarta candidatos que violam RN02.
5. Escolhe o candidato de maior lucro esperado e devolve também o preço "competitivo" (igual ou abaixo do menor
   preço relevante) e o preço "margem máxima" para o vendedor comparar.

**Fluxo alternativo**
- 1a. Custo não cadastrado: recomenda pela posição de mercado (ligeiramente abaixo da mediana) e avisa que a margem
  não pôde ser verificada.
- 4a. Nenhum candidato respeita RN02: recomenda o preço mínimo permitido e avisa que o produto não é competitivo
  com a estrutura de custo atual.

**Saída extra:** o detalhamento de custos no preço recomendado (`pricing.cost_breakdown`), mostrado no relatório.

**Rastreabilidade:** `src/analysis/pricing.ts` (`recommendPrice`), `src/costs.ts` (`asFeeFn`).

---

## UC03 Gerar relatório de mercado

**Ator principal:** Vendedor.
**Pré-condição:** existe pelo menos um `market_snapshot` para o produto.

**Fluxo principal**
1. O vendedor escolhe um produto e clica em "Ver relatório".
2. O sistema busca o snapshot mais recente.
3. O sistema apresenta, nesta ordem: resumo executivo (o que fazer agora), preços dos concorrentes, melhor preço,
   palavras-chave, celular x computador, motivos de avaliações ruins e plano de ação.
4. O vendedor pode exportar em HTML (pronto para imprimir em PDF) ou XLSX.

**Fluxo alternativo**
- 2a. Não há snapshot: o sistema oferece executar UC02.

**Rastreabilidade:** `src/report/html.ts`, `src/report/xlsx.ts`, rotas `/api/products/{id}/report*`.

---

## UC04 Dashboard de vendas e faturamento

**Ator principal:** Vendedor.

**Fluxo principal**
1. O sistema recebe pedidos por webhook ou pela sincronização periódica e grava em `orders`.
2. O vendedor abre o dashboard e escolhe o período (hoje, 7, 15, 30 dias, mês atual, ano atual).
3. O vendedor pode filtrar por uma conta específica ou ver todas as contas da loja juntas.
4. O sistema agrega no banco D1 (somas em SQL) e mostra: faturamento bruto, faturamento líquido (após comissão e frete pago),
   quantidade de pedidos, ticket médio, unidades vendidas, **total vendido no mês atual** comparado ao mês anterior,
   faturamento por conta e por marketplace, curva diária e os 5 produtos mais vendidos.

**Regra:** responder em menos de 800 ms para até 90 dias (RNF03), com os índices definidos em `migrations/0001_init.sql`.

**Rastreabilidade:** `src/dashboard.ts` (`salesSummary`).

---

## UC05 Central de perguntas dos anúncios

**Ator principal:** Vendedor.

**Fluxo principal**
1. O comprador pergunta num anúncio; o marketplace notifica o webhook.
2. O sistema grava a pergunta com status `UNANSWERED`, a conta de origem e uma sugestão de resposta baseada na ficha
   do produto: escrita pelo Gemini quando disponível (até 20 por sincronização, marcada como "Sugestão escrita pela
   IA") ou por modelo de resposta por tema.
3. O dashboard mostra: perguntas sem resposta, tempo médio de resposta, perguntas por produto e os temas mais
   perguntados (frete, compatibilidade, garantia, estoque, medidas, etc.).
4. O vendedor revisa a sugestão e envia; o sistema publica a resposta no marketplace e marca `ANSWERED`.

**Exceção**
- 4e. O marketplace recusa a resposta: a pergunta continua `UNANSWERED` e o erro aparece para o vendedor.

**Rastreabilidade:** `src/dashboard.ts` (`questionsSummary`), `src/api.ts` (`/api/questions/{id}/answer`).

---

## UC11 Acompanhar estoque

**Ator principal:** Vendedor.

**Fluxo principal**
1. O sistema sincroniza a quantidade em estoque de cada anúncio.
2. O dashboard mostra estoque total, valor do estoque a custo, produtos sem estoque e a **cobertura em dias**
   (estoque ÷ média diária de vendas dos últimos 30 dias).
3. Produtos com cobertura abaixo de 15 dias recebem alerta de reposição.

**Rastreabilidade:** `src/dashboard.ts` (`stockSummary`).

---

## UC14 Calcular custos e lucro do produto

**Ator principal:** Vendedor. **Referência:** extensões de calculadora para vendedores do Mercado Livre (ex.: Zinx).

**Pergunta do vendedor:** "Quanto sobra de cada venda, e a que preço preciso vender para ter a margem que quero?"

**Pré-condição:** a loja tem um perfil de custos (`sellers.cost_profile`); sem perfil, valem os padrões
(Premium, coleta, 6% de impostos, margem desejada de 20%).

**Fluxo principal**
1. O vendedor abre a Calculadora, escolhe um produto da loja (preço, custo, peso, dimensões e embalagem vêm do
   cadastro) ou faz uma simulação livre.
2. Informa ou ajusta preço, custo, tipo de anúncio (Clássico ou Premium) e modalidade de envio (coleta, Full, Flex
   ou envio próprio).
3. O sistema consulta uma vez no marketplace a comissão do tipo de anúncio na categoria e o frete grátis pago pelo
   vendedor (por peso e dimensões). Sem conta conectada, usa a referência local (`estimativa`).
4. Calcula por unidade: custo do produto, comissão, tarifa fixa (abaixo de R$ 79), frete conforme a modalidade,
   impostos, Mercado Ads, parcelamento, outros percentuais, embalagem e outros custos fixos.
5. Mostra lucro, margem líquida, ROI sobre o custo, markup, o valor que o marketplace repassa, o preço de
   equilíbrio (lucro zero) e o menor preço que atinge a margem desejada.
6. Compara os seis cenários (Clássico e Premium × coleta, Full e Flex) no mesmo preço e destaca o melhor.
7. Dono ou Administrador podem salvar os parâmetros como padrão da loja.

**Regras**
- Frete por modalidade: coleta usa o frete grátis do Mercado Envios; Full soma a armazenagem por unidade do perfil;
  Flex usa o custo médio de entrega informado pelo vendedor; envio próprio usa o custo do perfil.
- Abaixo do limite de frete grátis (R$ 79, configurável) o comprador paga o frete e o vendedor paga a tarifa fixa.
- A margem não cresce de forma contínua com o preço: ao passar de R$ 79 entra o frete. A busca do preço alvo testa
  o centavo anterior ao limite e não aceita margem arredondada (19,95% não conta como 20%).
- Os campos alterados numa simulação valem só para ela; o perfil da loja muda apenas ao salvar (RN09).
- Cada linha do detalhamento informa a fonte (RN01): `api`, `estimativa`, `perfil`, `regra` ou `informado`.

**Fluxo alternativo**
- 3a. A API do marketplace falha: usa 11,5% (Clássico) / 16,5% (Premium) e a tabela de frete de referência, marcadas
  como `estimativa`.

**Rastreabilidade:** `src/costs.ts` (`CostCalculator`), `src/api.ts` (`/api/calculator`,
`/api/sellers/{id}/cost-profile`), aba Calculadora do painel.

---

## UC15 Raio-x de anúncio

**Ator principal:** Vendedor. **Referência:** ferramentas de análise de anúncios (ex.: Genius Pro).

**Pergunta do vendedor:** "Quanto esse concorrente vende e fatura, quais palavras-chave ele usa e o que falta no
meu anúncio?"

**Fluxo principal**
1. O vendedor cola o link ou o código do anúncio (MLB...). O sistema extrai o código (aceita link de produto, link
   de catálogo com `item_id`/`wid` e o código com ou sem hífen).
2. Busca os dados do anúncio: preço, vendidos, data de criação, vendedor e reputação, loja oficial, tipo de anúncio,
   modalidade de envio, frete grátis, fotos, vídeo, ficha técnica, descrição, visitas dos últimos 30 dias e
   avaliações.
3. Estima vendas e faturamento (RN11): acumulado, por mês e por dia, e a conversão (vendas ÷ visitas).
4. Busca os concorrentes do mesmo produto e calcula as palavras-chave associadas (UC07), marcando quais estão no
   título e quais termos fortes faltam, e o que o comprador digita na busca (autocompletar do marketplace).
5. Dá uma nota de qualidade de 0 a 100 com dez critérios: título de 40 a 60 caracteres, uso das palavras-chave
   fortes, pelo menos 6 fotos, vídeo, ficha técnica 80% preenchida, descrição com 500 caracteres, frete grátis,
   Full ou Flex, Premium e nota média 4,5 ou mais.
6. Mostra a posição de preço do anúncio no mercado e a logística dos concorrentes (UC06, passo 5).
7. O vendedor pode passar a monitorar o anúncio (UC17).

**Fluxo alternativo**
- 2a. Anúncio inexistente ou inacessível: o sistema informa que não conseguiu ler o anúncio.
- 3a. Anúncio monitorado com histórico suficiente: as vendas do período passam a `calculado`.

**Rastreabilidade:** `src/analysis/ads.ts` (`parseItemId`, `estimateSales`, `qualityScore`, `analyzeAd`),
`src/ad_service.ts` (`analyzeAdForOrg`), `src/api.ts` (`/api/ads/analyze`, `/api/ads/recent`).

---

## UC16 Pesquisa de mercado por termo

**Ator principal:** Vendedor.

**Pergunta do vendedor:** "Quanto esse mercado fatura, quem domina e vale a pena entrar?"

**Fluxo principal**
1. O vendedor digita um termo de busca e, se quiser, filtra por modalidade de envio (RN12).
2. O sistema busca até 50 anúncios do termo e estima o faturamento acumulado de cada um (RN11).
3. Para os 10 que mais faturam, busca a data de criação e estima o faturamento por mês.
4. Mostra: faturamento total estimado, concentração dos 10 maiores (e o nível de concorrência), preço mediano e
   faixa de preços, participação de Full, Flex, lojas oficiais, Premium e frete grátis, vendedores que mais faturam
   e a tabela de anúncios, cada um com atalho para o raio-x (UC15).

**Rastreabilidade:** `src/analysis/ads.ts` (`marketOverview`), `src/ad_service.ts` (`marketResearch`),
`src/api.ts` (`/api/market/research`).

---

## UC17 Monitorar anúncios de concorrentes

**Atores:** Vendedor, Agendador.

**Fluxo principal**
1. O vendedor marca um anúncio para monitorar (a partir do raio-x ou pelo código).
2. O sistema tira a primeira foto (preço, vendidos, estoque, visitas e modalidade de envio).
3. Todo dia às 05:30 o Agendador tira uma nova foto de cada anúncio monitorado, usando uma conta ativa da empresa.
4. A lista de monitorados mostra preço atual, variação de preço em 30 dias, vendas em 7 e 30 dias, faturamento em
   30 dias e modalidade de envio. Vendas aparecem como "aguardando" até existirem duas fotos no período.
5. O vendedor pode parar de monitorar a qualquer momento.

**Regras:** o monitoramento pertence à empresa (RN07): uma empresa não vê o que a outra monitora. A mesma foto
diária de um anúncio serve a todas as empresas que o monitoram.

**Rastreabilidade:** `src/ad_service.ts` (`track`, `untrack`, `trackedList`, `snapshotItems`),
`src/scheduler.ts` (`dueJobs`), `src/index.ts` (`scheduled`), `src/api.ts` (`/api/ads/tracked`).

---

## 4. Matriz de rastreabilidade

| Requisito | Casos de uso | Módulo |
|---|---|---|
| RF01 Conexão OAuth (várias contas) | UC01 | `api.ts`, `services.ts`, `security.ts`, `connectors/` |
| Novo: Multiempresa e usuários | UC12, UC13 | `auth.ts`, `api.ts` |
| Novo: IA generativa gratuita (Gemini) | UC02, UC05, UC09 | `ai/` |
| RF02 Preços de concorrentes | UC02, UC06 | `analysis/pricing.ts` |
| RF03 Termos de busca | UC07 | `analysis/keywords.ts` |
| RF04 Celular x computador | UC08 | `analysis/devices.ts` |
| RF05 Recomendações | UC02, UC10 | `analysis/recommendations.ts` |
| RF06 Pedidos e faturamento | UC04 | `dashboard.ts` |
| RF07 Perguntas | UC05 | `dashboard.ts`, `api.ts` |
| RF08 Exportação | UC03 | `report/html.ts`, `report/xlsx.ts` |
| Novo: Avaliações ruins | UC09 | `analysis/reviews.ts` |
| Novo: Melhor preço | UC10 | `analysis/pricing.ts` |
| Novo: Estoque | UC11 | `dashboard.ts` |
| Novo: Calculadora de custos (estilo Zinx) | UC14, UC10 | `costs.ts` |
| Novo: Full x Flex como parâmetro | UC06, UC10, UC16 | `analysis/logistics.ts`, `connectors/` |
| Novo: Raio-x de anúncio (estilo Genius Pro) | UC15 | `analysis/ads.ts`, `ad_service.ts` |
| Novo: Pesquisa de mercado e faturamento | UC16 | `analysis/ads.ts`, `ad_service.ts` |
| Novo: Monitoramento de anúncios | UC17 | `ad_service.ts`, `scheduler.ts` |
| RNF01 Rate limit/backoff | RN05 | `connectors/base.ts` |
| RNF02 AES-256-GCM | RN04 | `security.ts` |
| RNF03 Dashboard < 800 ms | UC04 | `migrations/0001_init.sql` (índices) |
| RNF04 Workers isolados | UC02 | `internal.ts`, `scheduler.ts` |
