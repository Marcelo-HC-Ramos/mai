# Deployment MAI em Ycorn + Cloudflare

Guia para servidor próprio com Docker. O caminho mais simples, sem servidor, está em [RENDER.md](RENDER.md).

## 📋 Pré-requisitos

- Acesso SSH ao servidor Ycorn
- Docker e Docker Compose instalados (ou Python 3.11+)
- Domínio mai.ramosys.com.br configurado no Cloudflare
- Git instalado no servidor

## 🚀 Opção 1: Deploy com Docker (Recomendado)

### 1. Conectar ao Ycorn via SSH

```bash
ssh seu_usuario@seu_ip_ycorn
```

### 2. Clonar o repositório

```bash
cd /opt
git clone https://github.com/Marcelo-HC-Ramos/mai.git
cd mai
```

### 3. Criar arquivo `.env` de produção

```bash
cp .env.example .env
nano .env
```

**Variáveis essenciais a alterar:**

```bash
# SEGURANÇA - gere novos valores:
# $ python -c "import secrets; print(secrets.token_hex(32))"
MAI_SECRET_KEY=seu_token_secreto_32_chars_aqui

# $ python -m mai.cli gen-key
MAI_ENCRYPTION_KEY=sua_chave_encriptacao_aqui

# Senhas do banco de dados (ALTERE!)
MONGO_PASSWORD=sua_senha_mongo_super_segura_aqui
REDIS_PASSWORD=sua_senha_redis_super_segura_aqui

# Seu domínio
MAI_DOMAIN=mai.ramosys.com.br

# Gemini (opcional - deixe vazio para usar fallback)
GEMINI_API_KEY=sua_chave_gemini_opcional

# Mercado Livre (opcional - deixe como "demo" por enquanto)
MAI_CONNECTOR=demo
```

### 4. Iniciar containers

```bash
docker-compose up -d
```

Verificar status:
```bash
docker-compose ps
docker logs mai-api
```

### 5. Gerar chaves de segurança (primeira vez)

```bash
docker exec mai-api python -m mai.cli gen-key
# Salve a saída em MAI_ENCRYPTION_KEY no .env
docker-compose restart api worker
```

---

## 🚀 Opção 2: Deploy Native (sem Docker)

Se preferir rodar direto no Python:

### 1. Instalar dependências

```bash
cd /opt/mai
python3.11 -m pip install -r requirements.txt
```

### 2. Instalar MongoDB e Redis

```bash
# MongoDB
apt-get install -y mongodb-org

# Redis
apt-get install -y redis-server
```

### 3. Criar arquivo `.env`

```bash
cp .env.example .env
nano .env
```

Configure:
```bash
MAI_MONGO_URI=mongodb://mairoot:senha_aqui@localhost:27017/mai?authSource=admin
MAI_REDIS_URL=redis://:senha_aqui@localhost:6379/0
# ... outras variáveis como acima
```

### 4. Iniciar serviços

```bash
# Terminal 1: API
python -m uvicorn mai.api:app --host 0.0.0.0 --port 8000

# Terminal 2: Worker (em background)
celery -A mai.tasks worker -B --loglevel=info
```

---

## 🔧 Configurar Reverse Proxy (Nginx/Apache)

A aplicação roda na porta 8000 internamente, mas Cloudflare vai servir via HTTPS.

### Com Nginx

```bash
cat > /etc/nginx/sites-available/mai.ramosys.com.br << 'EOF'
upstream mai_app {
    server 127.0.0.1:8000;
}

server {
    listen 80;
    server_name mai.ramosys.com.br;
    
    location / {
        proxy_pass http://mai_app;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_redirect off;
    }
}
EOF

sudo ln -s /etc/nginx/sites-available/mai.ramosys.com.br /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

---

## ☁️ Configurar Cloudflare

Ver arquivo **cloudflare-setup.md** para instruções completas.

### Resumo rápido:

1. **DNS:** `mai.ramosys.com.br` → IP do seu Ycorn
2. **SSL/TLS:** Full (Strict recomendado se tiver HTTPS local)
3. **Page Rules:**
   - Cache Everything: `mai.ramosys.com.br/static/*`
   - Bypass Cache: `mai.ramosys.com.br/api/*`

---

## ✅ Testes de Produção

### 1. Verificar API

```bash
curl -I https://mai.ramosys.com.br
# Deve retornar 200 OK
```

### 2. Verificar Dashboard

Abra https://mai.ramosys.com.br no navegador, faça login com:
- Email: `demo@mai.local`
- Senha: `demo12345`

### 3. Verificar banco de dados

```bash
docker exec mai-mongo mongosh -u mairoot -p
> use mai
> db.organizations.count()
> db.products.count()
```

### 4. Verificar workers (snapshots de anúncios)

```bash
docker logs mai-worker | tail -20
# Deve ver mensagens de "snapshot_all_tracked" às 05:30 UTC diariamente
```

---

## 🔄 Updates e Manutenção

### Deploy nova versão do código

```bash
cd /opt/mai
git pull origin main
docker-compose restart api worker
```

### Monitorar logs

```bash
# Todos os containers
docker-compose logs -f

# Apenas API
docker-compose logs -f mai-api

# Apenas worker
docker-compose logs -f mai-worker
```

### Backup MongoDB

```bash
docker exec mai-mongo mongodump -u mairoot -p $MONGO_PASSWORD \
  --authenticationDatabase admin \
  --out /backup
```

### Restaurar backup

```bash
docker exec mai-mongo mongorestore -u mairoot -p $MONGO_PASSWORD \
  --authenticationDatabase admin \
  /backup
```

---

## 🚨 Troubleshooting

### Containers não iniciam

```bash
docker-compose logs
```

Procure por erros de conexão ou credenciais.

### Erro de autenticação MongoDB

Verifique se `MONGO_PASSWORD` no `.env` é igual ao esperado:
```bash
docker exec mai-mongo mongosh -u mairoot -p <senha>
```

### Cloudflare retorna 502

- Verifique se reverse proxy (nginx) está rodando: `systemctl status nginx`
- Verifique se API está rodando: `docker ps`
- Verifique firewall: `sudo ufw allow 80/tcp && sudo ufw allow 443/tcp`

### Tarefas agendadas não rodam

- Verifique worker: `docker compose logs mai-worker`
- Verifique Redis: `docker exec mai-redis redis-cli ping` (deve retornar PONG)

---

## 📞 Suporte

Para dúvidas ou problemas, consulte:
- GitHub: https://github.com/Marcelo-HC-Ramos/mai/issues
- Logs: `docker-compose logs -f`
- Testes: `docker exec mai-api python -m pytest tests/`
