#!/bin/bash
# Script de deployment do MAI para Ycorn
# Uso: ./deploy.sh [start|restart|update|logs|backup|restore]

set -e

PROJECT_DIR=$(cd "$(dirname "$0")" && pwd)
BACKUP_DIR="$PROJECT_DIR/backups"
ENV_FILE="$PROJECT_DIR/.env"
COMPOSE_FILE="$PROJECT_DIR/docker-compose.yml"

# Cores para output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Verificar se arquivo .env existe
check_env() {
    if [ ! -f "$ENV_FILE" ]; then
        log_error "Arquivo .env não encontrado!"
        log_info "Copie .env.example para .env e configure:"
        echo "  cp .env.example .env"
        echo "  nano .env"
        exit 1
    fi
}

# Verificar Docker
check_docker() {
    if ! command -v docker &> /dev/null; then
        log_error "Docker não está instalado!"
        exit 1
    fi

    if ! command -v docker-compose &> /dev/null; then
        log_error "Docker Compose não está instalado!"
        exit 1
    fi
}

# Iniciar containers
start() {
    log_info "Iniciando containers..."
    docker-compose -f "$COMPOSE_FILE" up -d
    log_info "✓ Containers iniciados"

    log_info "Aguardando serviços ficarem ready..."
    sleep 5

    status
}

# Reiniciar containers
restart() {
    log_info "Reiniciando containers..."
    docker-compose -f "$COMPOSE_FILE" restart
    log_info "✓ Containers reiniciados"
}

# Update (git pull + restart)
update() {
    log_info "Atualizando código..."
    git pull origin main

    log_info "Reconstruindo imagem Docker..."
    docker-compose -f "$COMPOSE_FILE" build --no-cache api worker

    log_info "Reiniciando..."
    docker-compose -f "$COMPOSE_FILE" up -d

    log_info "✓ Atualização concluída"
    status
}

# Status dos containers
status() {
    log_info "Status dos containers:"
    docker-compose -f "$COMPOSE_FILE" ps
}

# Logs
logs() {
    service="${1:-}"

    if [ -z "$service" ]; then
        docker-compose -f "$COMPOSE_FILE" logs -f --tail=50
    else
        docker-compose -f "$COMPOSE_FILE" logs -f --tail=50 "$service"
    fi
}

# Testes
test() {
    log_info "Rodando testes..."
    docker exec mai-api python -m pytest tests/ -v
}

# Backup
backup() {
    mkdir -p "$BACKUP_DIR"

    TIMESTAMP=$(date +%Y%m%d_%H%M%S)
    BACKUP_FILE="$BACKUP_DIR/mai_backup_$TIMESTAMP.tar.gz"

    log_info "Criando backup em $BACKUP_FILE..."

    # Backup MongoDB
    log_info "Fazendo backup de MongoDB..."
    docker exec mai-mongo mongodump -u mairoot -p "$(grep MONGO_PASSWORD $ENV_FILE | cut -d= -f2)" \
        --authenticationDatabase admin \
        --out /tmp/mongodb_backup > /dev/null 2>&1

    # Empacotar tudo
    tar -czf "$BACKUP_FILE" \
        -C "$PROJECT_DIR" .env docker-compose.yml \
        -C /tmp mongodb_backup \
        2>/dev/null || true

    log_info "✓ Backup criado: $BACKUP_FILE"

    # Limpeza
    docker exec mai-mongo rm -rf /tmp/mongodb_backup

    # Manter apenas últimos 7 backups
    find "$BACKUP_DIR" -type f -name "mai_backup_*.tar.gz" -mtime +7 -delete
    log_info "Backups antigos removidos (mantendo últimos 7 dias)"
}

# Restore
restore() {
    backup_file="${1:-}"

    if [ -z "$backup_file" ]; then
        log_error "Uso: $0 restore <arquivo_backup.tar.gz>"
        exit 1
    fi

    if [ ! -f "$backup_file" ]; then
        log_error "Arquivo não encontrado: $backup_file"
        exit 1
    fi

    log_warn "Você está prestes a restaurar um backup. Continuar? (s/n)"
    read -r confirm

    if [ "$confirm" != "s" ]; then
        log_info "Operação cancelada"
        exit 0
    fi

    log_info "Parando containers..."
    docker-compose -f "$COMPOSE_FILE" stop

    log_info "Extraindo backup..."
    tar -xzf "$backup_file" -C /tmp

    log_info "Restaurando MongoDB..."
    docker exec mai-mongo mongorestore -u mairoot -p "$(grep MONGO_PASSWORD $ENV_FILE | cut -d= -f2)" \
        --authenticationDatabase admin \
        /tmp/mongodb_backup

    log_info "Iniciando containers..."
    docker-compose -f "$COMPOSE_FILE" up -d

    log_info "✓ Restore concluído"
    status
}

# Saúde
health() {
    log_info "Verificando saúde dos serviços..."

    # API
    if curl -s -f http://localhost:8000 > /dev/null; then
        log_info "✓ API está respondendo"
    else
        log_error "✗ API não está respondendo"
    fi

    # MongoDB
    if docker exec mai-mongo mongosh -u mairoot -p "$(grep MONGO_PASSWORD $ENV_FILE | cut -d= -f2)" \
        --authenticationDatabase admin --eval "db.adminCommand('ping')" > /dev/null 2>&1; then
        log_info "✓ MongoDB está rodando"
    else
        log_error "✗ MongoDB não está respondendo"
    fi

    # Redis
    if docker exec mai-redis redis-cli ping > /dev/null 2>&1; then
        log_info "✓ Redis está rodando"
    else
        log_error "✗ Redis não está respondendo"
    fi
}

# Menu de ajuda
help() {
    cat << EOF
Uso: ./deploy.sh <comando>

Comandos:
  start              Iniciar containers
  restart            Reiniciar containers
  update             Atualizar código e redeploy
  status             Mostrar status dos containers
  logs [service]     Mostrar logs (api, mongo, redis, worker)
  test               Rodar testes
  health             Verificar saúde dos serviços
  backup             Fazer backup do banco de dados
  restore <arquivo>  Restaurar backup
  help               Mostrar esta mensagem

Exemplos:
  ./deploy.sh start
  ./deploy.sh logs api
  ./deploy.sh backup
  ./deploy.sh restore backups/mai_backup_20261006_120000.tar.gz

EOF
}

# Main
check_docker
check_env

cmd="${1:-help}"

case "$cmd" in
    start)
        start
        ;;
    restart)
        restart
        ;;
    update)
        update
        ;;
    status)
        status
        ;;
    logs)
        logs "$2"
        ;;
    test)
        test
        ;;
    health)
        health
        ;;
    backup)
        backup
        ;;
    restore)
        restore "$2"
        ;;
    help|--help|-h)
        help
        ;;
    *)
        log_error "Comando desconhecido: $cmd"
        help
        exit 1
        ;;
esac
