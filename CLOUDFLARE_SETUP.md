# Configuração Cloudflare para ramosys.com.br

Guia passo-a-passo para configurar seu domínio no Cloudflare com reverse proxy seguro.

## 1️⃣ DNS - Apontar para seu servidor Ycorn

### Acesso Cloudflare

1. Abra https://dash.cloudflare.com/c508787e6c2c8fe7985eee004b3ee796/ramosys.com.br
2. Clique em **DNS** no menu esquerdo

### Adicionar registro A

Você precisa do IP do seu servidor Ycorn. Se não souber, execute no Ycorn:

```bash
curl -s https://ifconfig.me
# Exemplo: 192.0.2.123
```

No Cloudflare DNS:

| Type | Name          | IPv4          | TTL  | Proxy         |
|------|---------------|---------------|------|---------------|
| A    | ramosys       | 192.0.2.123   | Auto | Proxied (🟠) |

O nome `ramosys` (sem .com.br) representa a raiz `ramosys.com.br`.

**⚠️ Importante:** Clique no ícone de nuvem para deixar **Proxied** (🟠 laranja), não DNS only (🔒 cinza).

---

## 2️⃣ SSL/TLS - Certificado HTTPS

### Modo SSL/TLS

1. Vá em **SSL/TLS** → **Overview**
2. Selecione modo: **Full (Strict)** recomendado

```
Full (Strict)
├─ Cliente → Cloudflare: HTTPS (Cloudflare fornece)
└─ Cloudflare → Seu servidor: HTTPS (seu certificado)
```

**Se seu servidor Ycorn não tiver HTTPS próprio:**
- Use modo **Full** (Cloudflare faz SSL, seu servidor pode ser HTTP)
- Mas **Full Strict é mais seguro** - considere adicionar certificado (Let's Encrypt grátis)

### Let's Encrypt no Ycorn (gratuito)

```bash
# Instalar Certbot
apt-get install -y certbot python3-certbot-nginx

# Gerar certificado
sudo certbot certonly --standalone -d ramosys.com.br

# Renovação automática
sudo systemctl enable certbot.timer
sudo systemctl start certbot.timer
```

---

## 3️⃣ Page Rules - Cache e Performance

### Configurar Page Rules

1. Vá em **Rules** → **Page Rules**
2. Clique em **Create Page Rule**

#### Rule 1: Cache Static Assets

```
URL: https://ramosys.com.br/static/*
Action: Cache Level = Cache Everything
TTL: 30 days
```

#### Rule 2: Bypass Cache para API

```
URL: https://ramosys.com.br/api/*
Action: Cache Level = Bypass Cache
```

#### Rule 3: Bypass Cache para Dashboard

```
URL: https://ramosys.com.br/*
Action: Cache Level = Bypass Cache
(já que tem dados dinâmicos de login/organização)
```

**Ordem importa!** Reordene para:
1. `/static/*`
2. `/api/*`
3. `/*` (geral)

---

## 4️⃣ Regras de Segurança (WAF)

### Challenge para IPs suspeitos

1. Vá em **Security** → **WAF**
2. Clique em **Create Rule**

#### Rule: Proteger /api contra bots

```
Condition: URI Path contains "/api"
AND Country is not "BR" (ajuste conforme público)
AND Bot Management Score > 50

Action: Challenge (CAPTCHA)
```

#### Rule: Rate Limiting

```
Condition: URI Path contains "/api/calculator"
Action: Rate Limit
Threshold: 100 requests por 10 minutos
Response: 429 Too Many Requests
```

---

## 5️⃣ Headers de Segurança

### Adicionar Headers HTTP

1. Vá em **Rules** → **Transform Rules** → **Modify Response Headers**
2. Clique em **Create Rule**

Adicione headers de segurança:

```
Rule Name: Security Headers

Condition: Leave blank (aplica a tudo)

Headers to add:
├─ X-Content-Type-Options: nosniff
├─ X-Frame-Options: SAMEORIGIN
├─ Strict-Transport-Security: max-age=31536000; includeSubDomains
├─ X-XSS-Protection: 1; mode=block
└─ Referrer-Policy: strict-origin-when-cross-origin
```

---

## 6️⃣ Workers (Opcional - Proteção Extra)

### Rate Limiting com Workers

Se quiser rate limit mais granular:

1. Vá em **Workers** → **Create Service**
2. Cole este código:

```javascript
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // Rate limit /api/calculator a 10 req/min por IP
    if (url.pathname.startsWith('/api/calculator')) {
      const ip = request.headers.get('CF-Connecting-IP');
      const key = `ratelimit:${ip}:calculator`;
      
      let count = await env.RATE_LIMIT.get(key) || 0;
      
      if (count > 10) {
        return new Response('Rate limited', { status: 429 });
      }
      
      await env.RATE_LIMIT.put(key, String(parseInt(count) + 1), {
        expirationTtl: 60
      });
    }
    
    return fetch(request);
  }
};
```

---

## 7️⃣ Verificar Configuração

### Testar HTTPS e Headers

```bash
# Verificar certificado
curl -I https://ramosys.com.br

# Esperar:
# HTTP/2 200
# strict-transport-security: max-age=31536000; includeSubDomains
# x-content-type-options: nosniff
```

### Testar Cache

```bash
# Static assets (deve cachear)
curl -I https://ramosys.com.br/static/style.css
# Procure por: cf-cache-status: HIT ou MISS

# API (não deve cacheiar)
curl -I https://ramosys.com.br/api/products
# Procure por: cf-cache-status: BYPASS ou DYNAMIC
```

### Verificar Proxy

```bash
# Conectividade
curl https://ramosys.com.br -v 2>&1 | grep "X-Powered-By"
# Seu servidor vai aparecer
```

---

## 8️⃣ Monitoramento

### Ativar Analytics

1. Vá em **Analytics** → **Overview**
2. Veja:
   - Requisições totais
   - Bandwidth salvo
   - Ataques bloqueados (WAF)

### Alertas

1. Vá em **Notifications** (sino no canto superior)
2. Configure alertas para:
   - ❌ HTTPS certificate expiring
   - 🚨 High error rate (4xx/5xx > 5%)
   - 🌐 High traffic spike

---

## 🔄 Updates de Configuração

### Depois que fizer deploy na API

Se alterar Mercado Livre:

```bash
# No Ycorn, após update do .env
ML_REDIRECT_URI=https://ramosys.com.br/auth/mercadolivre/callback
docker-compose restart api
```

---

## ✅ Checklist Final

- [ ] Registro DNS A aponta para IP do Ycorn
- [ ] DNS está Proxied (nuvem laranja 🟠)
- [ ] SSL/TLS em Full (Strict)
- [ ] Page Rules configuradas (cache, bypass)
- [ ] WAF ativado com regras básicas
- [ ] Headers de segurança adicionados
- [ ] Certificado HTTPS válido no servidor
- [ ] curl retorna 200 OK
- [ ] Dashboard acessível e com login funcionando
- [ ] API respondendo corretamente
- [ ] Analytics mostrando requisições

---

## 🆘 Troubleshooting Cloudflare

### "DNS resolution failed"

Verifique se IP do servidor está correto:
```bash
# No seu computador
ping ramosys.com.br
nslookup ramosys.com.br 1.1.1.1
```

### "526 Invalid SSL Certificate"

Seu servidor não tem certificado HTTPS válido. Opções:

1. **Descer para Full (não Strict)** - menos seguro
2. **Instalar Let's Encrypt** (recomendado)
3. **Gerar certificado auto-assinado** (apenas teste)

### "CNAME records don't match"

Se Ycorn pediu CNAME instead de A record:
- Use registro CNAME ao invés de A
- Aponte para: `ramosys.com.br.cdn.cloudflare.net`

### Cloudflare retorna 502/504

- Verifique se API está rodando: `docker ps`
- Verifique logs: `docker logs mai-api`
- Verifique firewall: `sudo ufw status`
- Reinicie: `docker-compose restart api`

---

## 📚 Recursos

- [Cloudflare DNS Docs](https://developers.cloudflare.com/dns/)
- [SSL/TLS Modes](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/)
- [Page Rules Priority](https://support.cloudflare.com/hc/en-us/articles/218411427)
- [WAF Rules](https://developers.cloudflare.com/waf/custom-rules/)
