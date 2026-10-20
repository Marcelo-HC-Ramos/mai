# MAI: Inteligência de Mercado e Painel do Vendedor

Agente em Python + MongoDB que faz a análise de mercado de cada produto de uma loja em marketplace e um painel
com vendas, perguntas e estoque. É multiempresa: várias empresas usam o mesmo servidor, cada uma com seus usuários,
lojas e contas de marketplace, sem enxergar os dados das outras. A especificação por casos de uso está em [docs/caso_de_uso.md](docs/caso_de_uso.md).

## O que o agente responde (por produto)

| Pergunta do vendedor | Caso de uso | Como é obtido | Fonte |
|---|---|---|---|
| Quais os preços dos concorrentes? | UC06 | Busca no marketplace por EAN/título, filtro de outliers (IQR), estatísticas | API do marketplace |
| Os concorrentes estão no Full ou no Flex? | UC06 | Modalidade de envio de cada anúncio (`shipping.logistic_type`), vendas e preço por modalidade | API do marketplace |
| Quais palavras-chave os compradores usam? | UC07 | Tendências de busca da categoria + termos dos títulos que mais vendem | API + cálculo (pontuação relativa) |
| Buscam mais pelo celular ou computador? | UC08 | Dados do vendedor quando existem; senão referência por categoria | **Estimativa** (o Mercado Livre não expõe esse dado) |
| Principal motivo das avaliações ruins? | UC09 | Avaliações de 1-3 estrelas dos concorrentes e do vendedor, classificadas por motivo | API do marketplace |
| Qual o melhor preço para vender? | UC10 | Lucro esperado (margem × conversão relativa) respeitando a margem mínima | Cálculo |

O resultado vira um relatório (HTML imprimível em PDF, ou Excel) com o plano de ação.

**Full ou Flex como parâmetro:** a análise aceita `modes` (`full`, `flex`, `coleta`, `proprio`, combináveis, ex.:
`POST /api/products/{id}/analyze?modes=full,flex`). Com o filtro, preços e melhor preço comparam só com quem usa
essa logística; o quadro "Full, Flex ou coleta?" do relatório continua mostrando o mercado inteiro, com a
participação nas vendas de cada modalidade, a modalidade dos 10 mais vendidos e quanto o Full cobra a mais.

## Calculadora de custos (estilo Zinx)

Aba **Calculadora** e `POST /api/calculator`. Para um preço, mostra quanto sobra de cada venda depois de comissão
(Clássico ou Premium), tarifa fixa abaixo de R$ 79, frete da modalidade (coleta, Full com armazenagem, Flex com seu
custo de entrega, envio próprio), impostos, Mercado Ads, parcelamento, embalagem e outros custos. Devolve lucro,
margem, ROI, markup, quanto o Mercado Livre repassa, preço de equilíbrio, preço para a margem desejada e a
comparação dos seis cenários (2 tipos de anúncio × coleta, Full, Flex). Com conta conectada, comissão e frete vêm
da API; sem conta, de uma tabela de referência marcada como estimativa. O perfil de custos fica por loja
(`GET/PUT /api/sellers/{id}/cost-profile`) e também alimenta o melhor preço do relatório.

## Análise de anúncios e mercado (estilo Genius Pro)

- **Raio-x de anúncio** (`POST /api/ads/analyze`): cole o link ou o código MLB de qualquer anúncio, seu ou de
  concorrente. Mostra vendas e faturamento estimados (acumulado, por mês, por dia), visitas e conversão, palavras-chave
  associadas (no título e faltando), o que o comprador digita na busca, nota de qualidade de 0 a 100 com o que
  melhorar, posição de preço e logística dos concorrentes.
- **Pesquisa de mercado** (`GET /api/market/research?q=`): faturamento estimado de um termo, concentração dos 10
  maiores, vendedores que mais faturam, preço mediano, participação de Full, Flex, lojas oficiais e Premium.
- **Monitoramento** (`/api/ads/tracked`): uma foto diária (05:30) de preço e vendidos dos anúncios escolhidos. Com
  duas fotos, vendas de 7 e 30 dias e faturamento passam de estimativa para cálculo.

## Empresas, usuários e contas

- **Empresa** (cliente do serviço) se cadastra na tela inicial e ganha um usuário Dono e uma primeira loja.
- **Usuários** por empresa, com papéis: Dono, Administrador (lojas, contas, equipe, configurações) e Analista
  (painéis, análises e respostas). Senhas com PBKDF2 e sessão por token assinado.
- **Lojas e contas:** cada loja aceita várias contas de marketplace, inclusive duas contas do Mercado Livre. O painel
  soma todas e o filtro "Conta" mostra uma de cada vez. Uma conta de marketplace só pode estar em uma empresa.
- **Isolamento:** todo documento leva `org_id` e toda rota filtra pela empresa do usuário (testado em `tests/test_tenancy.py`).

## IA gratuita (Gemini)

Com uma chave do [Google AI Studio](https://aistudio.google.com/apikey) (tem camada gratuita), o agente usa o Gemini para:
classificar os motivos das avaliações ruins, sugerir respostas às perguntas dos compradores e escrever o resumo do
relatório com sugestão de título e argumentos de venda. A chave pode ser global (`GEMINI_API_KEY`) ou própria de
cada empresa (tela Configurações, guardada criptografada). Sem chave, ou se a API falhar ou estourar o limite
gratuito, tudo continua funcionando com as regras locais e o relatório diz qual método foi usado.

Cuidados: na camada gratuita o Google pode usar o conteúdo enviado para melhorar seus serviços, então o MAI só envia
textos públicos (avaliações, perguntas sem identificação do comprador) e números do mercado. O limite gratuito por
minuto é respeitado com `GEMINI_RPM` (padrão 10). O modelo é configurável em `GEMINI_MODEL` (padrão `gemini-2.5-flash`).

## Painel do vendedor

- **Vendas:** faturamento bruto e líquido, faturamento por conta, pedidos, ticket médio, vendido no mês vs mês anterior, curva diária,
  faturamento por marketplace, 5 produtos que mais vendem. Períodos: hoje, 7, 15, 30 dias, mês, ano.
- **Perguntas:** pendentes com resposta sugerida (envio direto ao marketplace), tempo médio de resposta, temas mais perguntados.
- **Estoque:** unidades, valor a custo, produtos sem estoque, cobertura em dias e alerta de reposição.

## Colocar no ar (produção)

Caminho recomendado: Render + MongoDB Atlas, só pelo navegador, sem servidor nem Docker. Passo a passo em
[RENDER.md](RENDER.md). O arquivo `render.yaml` cria o serviço com um clique:
https://render.com/deploy?repo=https://github.com/Marcelo-HC-Ramos/mai

Com `MAI_SCHEDULER=1` as tarefas diárias rodam dentro da própria API (sem Redis/worker); `GET /healthz` verifica
o banco. Para servidor próprio com Docker, veja [DEPLOYMENT.md](DEPLOYMENT.md).

## Rodar em 1 minuto (sem instalar MongoDB, dados de demonstração)

```bash
pip install -r requirements.txt
MAI_MONGO_URI=mongomock:// MAI_SEED_DEMO=1 MAI_ENCRYPTION_KEY=$(python -m mai.cli gen-key) \
  uvicorn mai.api:app --port 8000
# abra http://localhost:8000 e entre com demo@mai.local / demo12345
```

`mongomock://` é um MongoDB em memória: os dados somem ao parar o servidor. A empresa de demonstração tem uma loja
com duas contas fictícias ("Conta principal" e "Conta outlet"). Para testar outra empresa, clique em "Criar conta da
empresa" e depois em "Adicionar conta de demonstração". Para ligar a IA, acrescente `GEMINI_API_KEY=...` ao comando.

## Rodar com MongoDB, Redis e workers

```bash
cp .env.example .env            # preencha MAI_ENCRYPTION_KEY (python -m mai.cli gen-key)
docker compose up --build       # mongo + redis + api + worker (Celery com agendamento)
```

O worker roda a varredura diária de todos os produtos às 06:00 e sincroniza pedidos e perguntas a cada 15 minutos.

## Conectar uma conta real do Mercado Livre

1. Crie um aplicativo em https://developers.mercadolivre.com.br/devcenter com a URL de retorno
   `http://SEU_HOST/auth/mercadolivre/callback` e o tópico de notificações apontando para `/webhooks/mercadolivre`.
2. Preencha `ML_CLIENT_ID`, `ML_CLIENT_SECRET`, `ML_REDIRECT_URI` e `MAI_CONNECTOR=mercadolivre` no `.env`.
3. No painel, aba "Contas", clique em "Conectar conta do Mercado Livre" e autorize. Repita para cada conta. Os tokens
   são gravados criptografados (AES-256-GCM) e anúncios, pedidos e perguntas de cada conta são importados.
4. Cadastre custo e preço mínimo de cada produto na aba "Análise de mercado" para a recomendação de preço respeitar sua margem.

## Adicionar outro marketplace

Crie uma classe em `mai/connectors/` herdando de `MarketplaceConnector` (busca de concorrentes, avaliações,
tendências, tarifas, anúncios, pedidos, perguntas) e registre em `mai/connectors/__init__.py`. Agente, relatório e
painel não mudam.

## Linha de comando

```bash
python -m mai.cli seed-demo                          # empresa de demonstração (use com MongoDB real)
python -m mai.cli create-org "Loja X" "Ana" ana@lojax.com senha1234   # cadastra uma empresa cliente
python -m mai.cli analyze <product_id>               # roda o agente para um produto
python -m mai.cli report <product_id> -o rel.xlsx    # exporta relatório (.html ou .xlsx)
```

## Estrutura

```
mai/
  agent.py            agente de varredura (UC02)
  costs.py            calculadora de custos e lucro (UC14)
  ad_service.py       raio-x, pesquisa de mercado e monitoramento de anúncios (UC15-UC17)
  auth.py             empresas, usuários, papéis, senhas e tokens (UC12, UC13)
  ai/                 gemini.py (cliente REST) · tasks.py (avaliações, respostas, resumo, com alternativa local)
  services.py         contas de marketplace (conectar, desconectar, conector por conta) e execução do agente
  analysis/           pricing.py (UC06, UC10) · logistics.py (Full/Flex) · keywords.py (UC07) · devices.py (UC08)
                      reviews.py (UC09) · ads.py (UC15, UC16) · recommendations.py
  connectors/         base.py (contrato, rate limit, backoff) · mercadolivre.py · demo.py
  dashboard.py        vendas (UC04) · perguntas (UC05) · estoque (UC11)
  report.py           relatório HTML/XLSX (UC03)
  sync.py             importação de anúncios, pedidos e perguntas
  api.py              FastAPI + OAuth + webhooks
  tasks.py            Celery (varredura diária, sincronização, fotos dos anúncios monitorados)
  web/index.html      painel do vendedor
docs/caso_de_uso.md   especificação por casos de uso
tests/                pytest (rode: python -m pytest)
```

## Limitações conhecidas

- O Mercado Livre não divulga volume absoluto de buscas nem o dispositivo de quem busca. O MAI mostra pontuação
  relativa e estimativa por categoria, sempre identificadas no relatório; importe dados próprios (Keyword Planner,
  Google Analytics, Mercado Ads) via `PATCH /api/products/{id}` (`keyword_volumes`, `traffic_devices`) para trocar a estimativa.
- A tabela de referência de dispositivos em `mai/analysis/devices.py` deve ser revisada periodicamente.
- A chance de conversão usada no melhor preço é um modelo de apoio à decisão, não uma previsão de vendas.
- Faturamento de concorrente é sempre estimativa (vendidos × preço atual). O Mercado Livre arredonda o total de
  vendidos em faixas para alguns anúncios; o monitoramento diário dá números melhores com o tempo.
- A tabela de frete da calculadora é uma referência aproximada; com conta conectada o valor vem da API. O custo do
  Flex e a armazenagem do Full dependem da operação de cada vendedor e são informados no perfil da loja.
- O autocompletar de busca usado no raio-x é um endpoint público não documentado do Mercado Livre e pode mudar.
- O conector do Mercado Livre segue a documentação oficial, mas ainda não foi testado contra uma conta real.
- Recuperação de senha por e-mail, cobrança/planos e limite de uso por empresa ainda não existem.
- Em produção, defina `MAI_SECRET_KEY` fixa; sem ela as sessões caem a cada reinício do servidor.
