# 🚀 Deployment MAI - Guia Passo-a-Passo (mai.ramosys.com.br)

**IP do servidor:** `179.110.102.40`  
**Domínio:** `mai.ramosys.com.br`

---

## FASE 1: Preparação no Seu Computador (5 min)

### Passo 1.1: Gerar Senhas Seguras

Abra terminal no seu computador e execute:

```bash
python3 -c "import secrets; print('MAI_SECRET_KEY:', secrets.token_hex(32))"
```

**Anote o resultado.** Exemplo:
```
MAI_SECRET_KEY: a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0
```

Repita para as outras senhas:

```bash
python3 -c "import secrets; print('MONGO_PASSWORD:', secrets.token_urlsafe(24))"
python3 -c "import secrets; print('REDIS_PASSWORD:', secrets.token_urlsafe(24))"
```

**Anote os 3 valores!** Você vai precisar quando configurar o `.env`.

---

## FASE 2: Conectar ao Servidor Ycorn (2 min)

### Passo 2.1: SSH do seu computador

No terminal do seu computador, conecte ao servidor:

```bash
ssh seu_usuario@179.110.102.40
```

Substituir `seu_usuario` pelo seu nome de usuário no Ycorn.

**Se pedir senha:** digite a senha do Ycorn.

**Sucesso?** Você vai ver algo como:
```
ubuntu@ycorn-server:~$
```

> **Dica:** Se não souber seu usuário/senha, contate suporte Ycorn.

---

## FASE 3: Instalar Docker (3-5 min)

### Passo 3.1: Instalar Docker

**Ainda no terminal do servidor Ycorn** (depois do SSH), rode:

```bash
curl -fsSL https://get.docker.com | sh
```

Isso vai demorar ~2-3 minutos. Aguarde até terminar.

**Se vir "Successfully installed docker"** → OK ✓

### Passo 3.2: Dar permissão para seu usuário

```bash
sudo usermod -aG docker $USER
newgrp docker
```

### Passo 3.3: Verificar Docker

```bash
docker --version
```

**Esperado:**
```
Docker version 27.x.x, build xxxxx
```

---

## FASE 4: Clonar o MAI (2 min)

### Passo 4.1: Ir para /opt

```bash
cd /opt
```

### Passo 4.2: Clonar repositório

```bash
git clone https://github.com/Marcelo-HC-Ramos/mai.git
cd mai
```

### Passo 4.3: Verificar arquivos

```bash
ls -la
```

**Esperado:** Você vai ver:
```
DEPLOYMENT_CHECKLIST.md
DEPLOYMENT.md
CLOUDFLARE_SETUP.md
docker-compose.yml
.env.example
deploy.sh
mai/
tests/
...
```

---

## FASE 5: Configurar .env (5 min)

### Passo 5.1: Criar arquivo .env

```bash
cp .env.example .env
nano .env
```

Isso abre um editor de texto. Você vai editar o arquivo `.env`.

### Passo 5.2: Preencher valores

Procure por estas linhas e altere:

**LINHA 1 - MAI_SECRET_KEY:**
```
MAI_SECRET_KEY=YOUR_LONG_RANDOM_SECRET_KEY_HERE_MIN_32_CHARS
```

Substitua por: (aquele que você gerou na Fase 1)
```
MAI_SECRET_KEY=a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0
```

**LINHA 2 - MONGO_PASSWORD:**
```
MONGO_PASSWORD=YOUR_SECURE_MONGO_PASSWORD_HERE
```

Substitua por: (aquele que você gerou)
```
MONGO_PASSWORD=abc123XYZ_mongo_password_aqui
```

**LINHA 3 - REDIS_PASSWORD:**
```
REDIS_PASSWORD=YOUR_SECURE_REDIS_PASSWORD_HERE
```

Substitua por: (aquele que você gerou)
```
REDIS_PASSWORD=xyz789ABC_redis_password_aqui
```

**LINHA 4 - MAI_DOMAIN:**
```
MAI_DOMAIN=mai.ramosys.com.br
```

(deixar como está - já está certo)

**LINHA 5 - MAI_CONNECTOR:**
```
MAI_CONNECTOR=demo
```

(deixar como está - depois você conecta com conta real de Mercado Livre)

### Passo 5.3: Salvar arquivo

- Pressione **CTRL + X**
- Digite **Y** (yes)
- Pressione **ENTER**

Voltou ao terminal? → Arquivo salvo ✓

### Passo 5.4: Verificar

```bash
cat .env | grep MAI_DOMAIN
```

**Esperado:**
```
MAI_DOMAIN=mai.ramosys.com.br
```

---

## FASE 6: Iniciar Docker Compose (5-10 min)

### Passo 6.1: Iniciar containers

```bash
docker-compose up -d
```

Isso vai:
1. Baixar imagens (MongoDB, Redis, Python)
2. Criar containers
3. Iniciar tudo

**Esperado:** Você vê
```
Creating mai-mongo ... done
Creating mai-redis ... done
Creating mai-api  ... done
Creating mai-worker ... done
```

### Passo 6.2: Aguardar inicialização

```bash
sleep 30
```

(Aguarda 30 segundos para tudo ficar pronto)

### Passo 6.3: Verificar status

```bash
docker-compose ps
```

**Esperado:** Todos os containers em `Up`
```
NAME                STATUS
mai-mongo           Up 2 minutes
mai-redis           Up 2 minutes
mai-api             Up 1 minute (healthy)
mai-worker          Up 1 minute
```

### Passo 6.4: Testar API

```bash
curl http://localhost:8000
```

**Esperado:** Você vê HTML da página inicial (não erro)

Se vir `Connection refused` → Aguarde mais 30s e tente de novo.

---

## FASE 7: Instalar Nginx (Reverse Proxy) (3 min)

### Passo 7.1: Instalar Nginx

```bash
sudo apt-get update
sudo apt-get install -y nginx
```

### Passo 7.2: Criar configuração

```bash
sudo nano /etc/nginx/sites-available/mai.ramosys.com.br
```

Copie e cole este conteúdo:

```nginx
upstream mai_app {
    server 127.0.0.1:8000;
}

server {
    listen 80;
    server_name mai.ramosys.com.br;
    
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name mai.ramosys.com.br;
    
    ssl_certificate /etc/letsencrypt/live/mai.ramosys.com.br/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mai.ramosys.com.br/privkey.pem;
    
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;
    
    location / {
        proxy_pass http://mai_app;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

- Pressione **CTRL + X** → **Y** → **ENTER**

### Passo 7.3: Ativar site

```bash
sudo ln -s /etc/nginx/sites-available/mai.ramosys.com.br /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

**Esperado:**
```
nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
nginx: configuration file /etc/nginx/nginx.conf test is successful
```

---

## FASE 8: Instalar Certificado SSL (Let's Encrypt) (2 min)

### Passo 8.1: Instalar Certbot

```bash
sudo apt-get install -y certbot python3-certbot-nginx
```

### Passo 8.2: Gerar certificado

```bash
sudo certbot certonly --standalone -d mai.ramosys.com.br
```

Você vai ver perguntas:
- **Email:** digite seu email
- **Agree to terms:** digite `Y`
- **Subscribe to updates:** `N` (opcional)

**Esperado:**
```
Successfully received certificate.
Certificate is saved at: /etc/letsencrypt/live/mai.ramosys.com.br/fullchain.pem
```

### Passo 8.3: Auto-renovação

```bash
sudo systemctl enable certbot.timer
sudo systemctl start certbot.timer
```

---

## FASE 9: Configurar Cloudflare (3 min)

### Passo 9.1: Abrir Cloudflare

Abra no seu navegador:  
https://dash.cloudflare.com/c508787e6c2c8fe7985eee004b3ee796/ramosys.com.br

### Passo 9.2: Ir para DNS

- Clique em **DNS** (menu esquerdo)

### Passo 9.3: Adicionar record A

Clique em **Add record**

Preencha:
- **Type:** A
- **Name:** mai
- **IPv4 address:** 179.110.102.40
- **TTL:** Auto
- **Proxy status:** **Proxied** (nuvem laranja 🟠)

Clique em **Save**

### Passo 9.4: Configurar SSL/TLS

- Clique em **SSL/TLS** (menu esquerdo)
- Selecione **Full (Strict)**

---

## FASE 10: Teste Final (2 min)

### Passo 10.1: Aguardar DNS propagação

DNS pode levar 2-10 minutos. Enquanto aguarda, teste com IP direto.

### Passo 10.2: Testar no seu computador

```bash
# Teste 1: Com IP
curl -k -I https://179.110.102.40

# Teste 2: Com domínio (após DNS propagar)
curl -I https://mai.ramosys.com.br
```

**Esperado:**
```
HTTP/2 200
```

### Passo 10.3: Abrir no navegador

Abra: https://mai.ramosys.com.br

**Esperado:** Você vê o dashboard MAI

### Passo 10.4: Login

- **Email:** demo@mai.local
- **Senha:** demo12345

**Esperado:** Você consegue acessar o painel! 🎉

---

## FASE 11: Verificar Tudo Funcionando (2 min)

### Passo 11.1: Verificar containers

De volta no servidor (SSH):

```bash
docker-compose ps
```

Todos devem estar em `Up` ✓

### Passo 11.2: Verificar logs

```bash
docker logs mai-api | tail -20
```

Procure por erros. Se estiver limpo → OK ✓

### Passo 11.3: Verificar banco de dados

```bash
docker exec mai-mongo mongosh -u mairoot -p $MONGO_PASSWORD \
  --authenticationDatabase admin \
  --eval "db.adminCommand('ping')"
```

**Esperado:**
```
{ ok: 1 }
```

---

## ✅ SUCESSO!

Seu MAI está rodando em **https://mai.ramosys.com.br**! 🎉

### Próximos passos:
1. **Testar funcionalidades** (Calculadora, Anúncios, Pesquisa)
2. **Conectar conta Mercado Livre** (em Configurações)
3. **Monitorar logs** (diariamente)
4. **Fazer backups** (semanalmente)

---

## 🆘 Se der erro

### Docker não inicia
```bash
docker-compose logs
```
Procure pela mensagem de erro.

### Conexão MongoDB falha
Verifique senha no `.env`:
```bash
grep MONGO_PASSWORD .env
```

### SSL/HTTPS não funciona
Aguarde Let's Encrypt gerar certificado (pode levar alguns minutos).

### DNS não resolveu
Aguarde 10 minutos e tente: `ping mai.ramosys.com.br`

---

**Precisa de ajuda em algum passo? Me chama!** 👍
