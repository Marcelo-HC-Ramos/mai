# MAI: Inteligência de Mercado e Painel do Vendedor

Agente de análise de mercado para vendedores do Mercado Livre, com painel de vendas, perguntas e estoque,
calculadora de custos e ferramentas de anúncios. É multiempresa: cada empresa cliente cria a própria conta no site,
com seus usuários, lojas e contas de marketplace, sem enxergar os dados das outras.

Roda no **Cloudflare Workers** com banco **Cloudflare D1**, no plano grátis, em https://mai.ramosys.com.br.
**Para publicar, siga o [PUBLICAR.md](PUBLICAR.md)** (`npm install`, `npm run configurar`, `npm run verificar`).
A especificação por casos de uso está em [docs/caso_de_uso.md](docs/caso_de_uso.md).

## O que o agente responde (por produto)

| Pergunta do vendedor | Caso de uso | Como é obtido | Fonte |
|---|---|---|---|
| Quais os preços dos concorrentes? | UC06 | Busca no marketplace por EAN/título, filtro de outliers (IQR), estatísticas | API do marketplace |
| Os concorrentes estão no Full ou no Flex? | UC06 | Modalidade de envio de cada anúncio (`shipping.logistic_type`), vendas e preço por modalidade | API do marketplace |
| Quais palavras-chave os compradores usam? | UC07 | Tendências de busca da categoria + termos dos títulos que mais vendem | API + cálculo (pontuação relativa) |
| Buscam mais pelo celular ou computador? | UC08 | Dados do vendedor quando existem; senão referência por categoria | **Estimativa** (o Mercado Livre não expõe esse dado) |
| Principal motivo das avaliações ruins? | UC09 | Avaliações de 1-3 estrelas dos concorrentes e do vendedor, classificadas por motivo | API do marketplace |
| Qual o melhor preço para vender? | UC10 | Lucro esperado (margem × conversão relativa) respeitando a margem mínima | Cálculo |

O resultado vira um relatório (HTML imprimível em PDF, ou Excel) com o plano de ação. A análise aceita `modes`
(`full`, `flex`, `coleta`, `proprio`, combináveis: `POST /api/products/{id}/analyze?modes=full,flex`) para comparar
só com quem usa essa logística; o quadro "Full, Flex ou coleta?" continua mostrando o mercado inteiro.

## Outras ferramentas

- **Calculadora de custos (estilo Zinx)**, `POST /api/calculator`: comissão Clássico/Premium, tarifa fixa abaixo de
  R$ 79, frete por modalidade, impostos, Mercado Ads, parcelamento, embalagem; lucro, margem, ROI, markup, preço de
  equilíbrio, preço para a margem desejada e seis cenários. Perfil de custos por loja em `/api/sellers/{id}/cost-profile`.
- **Raio-x de anúncio (estilo Genius Pro)**, `POST /api/ads/analyze`: vendas e faturamento estimados, visitas e
  conversão, palavras-chave, nota de qualidade de 0 a 100, posição de preço e logística dos concorrentes.
- **Pesquisa de mercado**, `GET /api/market/research?q=`: faturamento estimado de um termo, concentração, vendedores
  que mais faturam, participação de Full, Flex, lojas oficiais e Premium.
- **Monitoramento**, `/api/ads/tracked`: uma foto diária de preço e vendidos; com duas fotos, as vendas passam de
  estimativa para cálculo.
- **Painel:** vendas (bruto, líquido, por conta, curva diária, mais vendidos), perguntas (pendentes com resposta
  sugerida, tempo de resposta, temas) e estoque (cobertura em dias e alerta de reposição).
- **IA grátis (Gemini):** classifica avaliações, sugere respostas e escreve o resumo do relatório. Sem chave, tudo
  funciona com as regras locais e o relatório diz qual método foi usado.

## Empresas, usuários e contas

- Papéis: Dono, Administrador (lojas, contas, equipe, configurações) e Analista (painéis, análises e respostas).
  Senhas com PBKDF2-SHA256 e sessão por token assinado (HMAC).
- Cada loja aceita várias contas de marketplace, inclusive duas do Mercado Livre. Uma conta só pode estar em uma empresa.
- Todo registro leva `org_id` e toda rota filtra pela empresa do usuário (testado em `test/api.test.ts`).
- Tokens do Mercado Livre e chaves do Gemini ficam criptografados com AES-256-GCM.

## Comandos

| Comando | O que faz |
|---|---|
| `npm run configurar` | Login na Cloudflare, cria o banco D1, publica e cria as chaves (pode repetir) |
| `npm run publicar` | Atualiza as tabelas do banco e publica a versão nova |
| `npm run verificar` | Confere se https://mai.ramosys.com.br está respondendo |
| `npm run logs` | Mostra ao vivo o que acontece no Worker |
| `npm run dev` | Roda no seu computador em http://localhost:8787 (banco local) |
| `npm test` | Testes no ambiente da Cloudflare (vitest + workerd + D1) |
| `npm run typecheck` | Verificação de tipos do TypeScript |

## Como funciona no plano grátis

O plano grátis do Workers dá poucos milissegundos de processamento por chamada, 50 requisições externas e 50
consultas ao banco. Por isso:

- Cada tarefa pesada (sincronizar uma conta, analisar um produto, fotografar anúncios) roda numa chamada separada do
  próprio Worker (`ctx.exports`), com os seus próprios limites.
- O agendador (Cron Trigger a cada 15 minutos) só escolhe o que está pendente e dispara em lotes pequenos:
  sincronização das contas reais, fotos dos anúncios monitorados (a partir das 05:30 UTC) e varredura diária de
  cada produto (a partir das 06:00 UTC, uma tentativa por produto por dia).
- Gravações em lote numa única consulta (`json_each`), somas dos painéis em SQL e o preço para a margem calculado por
  trechos lineares em vez de testar preço por preço.
- Contas de demonstração não sincronizam sozinhas (os dados delas não mudam).

## Conectar uma conta real do Mercado Livre

1. Crie um aplicativo em https://developers.mercadolivre.com.br/devcenter com a URL de retorno
   `https://mai.ramosys.com.br/auth/mercadolivre/callback` e as notificações em `https://mai.ramosys.com.br/webhooks/mercadolivre`.
2. Rode `npm run configurar` e informe o App ID e a Secret Key (ficam como segredos do Worker).
3. No painel, aba "Contas", clique em "Conectar conta do Mercado Livre". Repita para cada conta.

## Estrutura

```
src/
  index.ts            entrada do Worker: rotas, telas (public/) e agendador
  api.ts              rotas da API, OAuth do Mercado Livre e webhooks
  http.ts             roteador, respostas {"detail": ...} e validação
  internal.ts         chamadas do Worker para ele mesmo (tarefas em execuções separadas)
  scheduler.ts        o que o Cron Trigger dispara a cada 15 minutos
  db.ts               acesso ao D1 (documento JSON + colunas de busca, gravação em lote)
  auth.ts             empresas, usuários, papéis, senhas e tokens (UC12, UC13)
  security.ts         AES-256-GCM
  agent.ts            agente de varredura (UC02)
  costs.ts            calculadora de custos e lucro (UC14)
  ad_service.ts       raio-x, pesquisa de mercado e monitoramento de anúncios (UC15-UC17)
  services.ts         contas de marketplace e execução do agente
  sync.ts             importação de anúncios, pedidos e perguntas
  dashboard.ts        vendas (UC04), perguntas (UC05), estoque (UC11)
  questions.ts        temas e respostas modelo
  analysis/           pricing (UC06, UC10) · logistics (Full/Flex) · keywords (UC07) · devices (UC08)
                      reviews (UC09) · ads (UC15, UC16) · recommendations
  connectors/         base (contrato) · mercadolivre · demo
  ai/                 gemini (cliente REST) · tasks (avaliações, respostas, resumo)
  report/             html (UC03) · xlsx (planilha Excel)
public/index.html     painel do vendedor
migrations/           tabelas do D1
scripts/              configurar, publicar e verificar
test/                 testes (npm test)
docs/caso_de_uso.md   especificação por casos de uso
```

## Adicionar outro marketplace

Crie uma classe em `src/connectors/` herdando de `MarketplaceConnector` e registre em `src/connectors/index.ts`.
Agente, relatório e painel não mudam.

## Limitações conhecidas

- O Mercado Livre não divulga volume absoluto de buscas nem o dispositivo de quem busca. O MAI mostra pontuação
  relativa e estimativa por categoria, sempre identificadas; dados próprios podem ser importados via
  `PATCH /api/products/{id}` (`keyword_volumes`, `traffic_devices`).
- A chance de conversão usada no melhor preço é um modelo de apoio à decisão, não uma previsão de vendas.
- Faturamento de concorrente é sempre estimativa (vendidos × preço atual); o monitoramento diário melhora com o tempo.
- A tabela de frete da calculadora é uma referência aproximada; com conta conectada o valor vem da API.
- O autocompletar de busca usado no raio-x é um endpoint público não documentado do Mercado Livre e pode mudar.
- O conector do Mercado Livre segue a documentação oficial, mas ainda não foi testado contra uma conta real.
- Recuperação de senha por e-mail, cobrança/planos e limite de uso por empresa ainda não existem.
- A versão anterior em Python/MongoDB está no ramo `python-v1` do repositório.
