# 📋 Checklist de Deployment MAI em Ycorn

Siga este checklist passo-a-passo para colocar o MAI em produção.

## ✅ Fase 1: Preparação (seu computador)

- [ ] Clonar repositório: `git clone https://github.com/Marcelo-HC-Ramos/mai.git`
- [ ] Revisar DEPLOYMENT.md
- [ ] Revisar CLOUDFLARE_SETUP.md
- [ ] Gerar senhas seguras:
  ```bash
  python -c "import secrets; print('SECRET_KEY:', secrets.token_hex(32))"
  python -c "import secrets; print('MONGO_PASS:', secrets.token_urlsafe(24))"
  python -c "import secrets; print('REDIS_PASS:', secrets.token_urlsafe(24))"
  ```

---

## ✅ Fase 2: Configurar Cloudflare

1. Acessar dashboard: https://dash.cloudflare.com/c508787e6c2c8fe7985eee004b3ee796/ramosys.com.br

2. **DNS:**
   - [ ] Adicionar registro A: `mai` → `<SEU_IP_YCORN>`
   - [ ] Deixar como Proxied (nuvem laranja 🟠)

3. **SSL/TLS:**
   - [ ] Selecionar **Full (Strict)**

4. **Page Rules:**
   - [ ] Cache `/static/*` por 30 dias
   - [ ] Bypass cache `/api/*`

5. **Security (WAF):**
   - [ ] Ativar regras básicas

---

## ✅ Fase 3: Preparar Servidor Ycorn

### Conectar via SSH

```bash
ssh seu_usuario@seu_ip_ycorn
```

### Instalar Docker e Docker Compose

```bash
# Atualizar pacotes
sudo apt-get update && sudo apt-get upgrade -y

# Instalar Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker $USER

# Instalar Docker Compose
sudo apt-get install -y docker-compose

# Verificar
docker --version
docker-compose --version
```

### Instalar Nginx (reverse proxy)

```bash
sudo apt-get install -y nginx

# Verificar
nginx -v
```

### Instalar Certbot (SSL gratuito)

```bash
sudo apt-get install -y certbot python3-certbot-nginx

# Gerar certificado
sudo certbot certonly --standalone -d mai.ramosys.com.br

# Configurar renovação automática
sudo systemctl enable certbot.timer
sudo systemctl start certbot.timer
```

### Configurar firewall

```bash
sudo ufw allow 22/tcp   # SSH
sudo ufw allow 80/tcp   # HTTP
sudo ufw allow 443/tcp  # HTTPS
sudo ufw enable
```

---

## ✅ Fase 4: Deploy do MAI

### Clonar repositório

```bash
cd /opt
sudo git clone https://github.com/Marcelo-HC-Ramos/mai.git
sudo chown -R $USER:$USER mai
cd mai
```

### Criar arquivo .env

```bash
cp .env.example .env
nano .env
```

**Preencher com:**

```bash
# Senhas geradas na Fase 1
MAI_SECRET_KEY=<seu_secret_key_de_32_chars>
MAI_ENCRYPTION_KEY=<seu_encryption_key>
MONGO_PASSWORD=<sua_senha_mongo>
REDIS_PASSWORD=<sua_senha_redis>

# Domínio e ambiente
MAI_DOMAIN=mai.ramosys.com.br
MAI_ENVIRONMENT=production

# Connector (deixar como demo por enquanto)
MAI_CONNECTOR=demo

# Gemini (opcional)
GEMINI_API_KEY=<opcional_sua_chave_gemini>

# Mercado Livre (deixar vazio por enquanto)
ML_CLIENT_ID=
ML_CLIENT_SECRET=
ML_REDIRECT_URI=https://mai.ramosys.com.br/auth/mercadolivre/callback
```

### Iniciar containers

```bash
docker-compose up -d

# Verificar status
docker-compose ps

# Verificar logs
docker logs mai-api

# Aguardar 30 segundos para inicialização completa
sleep 30

# Testar API
curl http://localhost:8000
```

---

## ✅ Fase 5: Configurar Nginx (Reverse Proxy)

```bash
sudo nano /etc/nginx/sites-available/mai.ramosys.com.br
```

Cole este conteúdo:

```nginx
upstream mai_app {
    server 127.0.0.1:8000;
}

server {
    listen 80;
    server_name mai.ramosys.com.br;
    
    # Redirecionar HTTP para HTTPS
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name mai.ramosys.com.br;
    
    # Certificado SSL (Let's Encrypt)
    ssl_certificate /etc/letsencrypt/live/mai.ramosys.com.br/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mai.ramosys.com.br/privkey.pem;
    
    # Configurações SSL recomendadas
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;
    
    # Proxy
    location / {
        proxy_pass http://mai_app;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_redirect off;
        
        # WebSocket (se usar no futuro)
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

Salvar e ativar:

```bash
sudo ln -sf /etc/nginx/sites-available/mai.ramosys.com.br /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

---

## ✅ Fase 6: Testes

### Teste 1: Health Check

```bash
# No servidor
docker exec mai-api curl -f http://localhost:8000
# Deve retornar 200 OK
```

### Teste 2: HTTPS

```bash
# Do seu computador
curl -I https://mai.ramosys.com.br
# Deve retornar HTTP/2 200
# Verifique headers SSL
```

### Teste 3: Dashboard

1. Abrir https://mai.ramosys.com.br no navegador
2. Fazer login com:
   - Email: `demo@mai.local`
   - Senha: `demo12345`
3. Verificar:
   - [ ] Dashboard carrega
   - [ ] Aba "Calculadora" funciona
   - [ ] Aba "Anúncios" funciona
   - [ ] Aba "Pesquisa" funciona

### Teste 4: API

```bash
curl -X POST https://mai.ramosys.com.br/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"demo@mai.local","password":"demo12345"}'
# Deve retornar token
```

### Teste 5: Banco de dados

```bash
docker exec mai-mongo mongosh -u mairoot -p $MONGO_PASSWORD \
  --authenticationDatabase admin \
  --eval "db.organizations.find().limit(1)"
# Deve retornar dados
```

### Teste 6: Workers (Snapshots de Anúncios)

```bash
# Verificar se worker está rodando
docker logs mai-worker | tail -20

# Deve ver mensagens de tarefas Celery
```

---

## ✅ Fase 7: Configuração Pós-Deploy

### Gerar chave de encriptação (primeira vez)

```bash
docker exec mai-api python -m mai.cli gen-key
# Salvar saída em MAI_ENCRYPTION_KEY no .env
docker-compose restart api worker
```

### Backup automático

```bash
# Criar script de cron para backup diário
sudo nano /etc/cron.d/mai-backup
```

Cole:

```bash
# Backup MAI diariamente às 3 da manhã
0 3 * * * cd /opt/mai && /opt/mai/deploy.sh backup >> /var/log/mai-backup.log 2>&1
```

### Monitoramento

```bash
# Ver logs em tempo real
cd /opt/mai
docker-compose logs -f

# Ver apenas API
docker-compose logs -f mai-api

# Ver apenas worker
docker-compose logs -f mai-worker
```

---

## ✅ Fase 8: Conectar Mercado Livre (Opcional)

Quando quiser usar a conta real do Mercado Livre:

1. Criar aplicativo em https://developers.mercadolivre.com.br/devcenter
2. Obter `ML_CLIENT_ID` e `ML_CLIENT_SECRET`
3. Atualizar `.env`:
   ```bash
   MAI_CONNECTOR=mercadolivre
   ML_CLIENT_ID=seu_client_id
   ML_CLIENT_SECRET=seu_client_secret
   ML_REDIRECT_URI=https://mai.ramosys.com.br/auth/mercadolivre/callback
   ```
4. Reiniciar:
   ```bash
   cd /opt/mai
   docker-compose restart api
   ```
5. Fazer login no dashboard com conta real
6. Conectar conta Mercado Livre via OAuth

---

## ✅ Fase 9: Manutenção Contínua

### Updates do código

```bash
cd /opt/mai
git pull origin main
docker-compose build --no-cache api worker
docker-compose restart api worker
```

### Backup (semanal)

```bash
cd /opt/mai
./deploy.sh backup
# Arquivo criado em: backups/mai_backup_YYYYMMDD_HHMMSS.tar.gz
```

### Monitoramento (logs)

```bash
# Alertar se houver erros
docker logs mai-api | grep ERROR
docker logs mai-worker | grep ERROR
```

---

## 🆘 Troubleshooting

| Problema | Solução |
|----------|---------|
| **Cloudflare 502** | Verificar se nginx rodando: `systemctl status nginx` |
| **API não responde** | `docker ps` e `docker logs mai-api` |
| **MongoDB connection error** | `docker logs mai-mongo` |
| **Certificado SSL inválido** | `sudo certbot renew --force-renewal` |
| **Porta 8000 em uso** | `lsof -i :8000` e verificar outro serviço |
| **Sem espaço em disco** | `docker system prune -a` e `docker volume prune` |

---

## 📞 Suporte

Qualquer problema:

1. Verificar logs: `cd /opt/mai && docker-compose logs`
2. Rodar testes: `docker exec mai-api python -m pytest tests/`
3. GitHub Issues: https://github.com/Marcelo-HC-Ramos/mai/issues
4. Documentação: DEPLOYMENT.md e CLOUDFLARE_SETUP.md nesta pasta

---

## ✨ Próximos Passos

- [ ] Monitorar logs por 24h após deploy
- [ ] Testar funcionalidade com dados reais
- [ ] Conectar conta Mercado Livre oficial
- [ ] Configurar alertas Cloudflare
- [ ] Fazer backup semanal automático
- [ ] Revisar segurança (HTTPS, WAF, senhas)
- [ ] Documentar procedimentos operacionais
