#!/usr/bin/env bash
#
# Installe le serveur Komoku sur une machine Debian, Ubuntu ou Raspberry Pi OS.
#
#   sudo ./install-serveur.sh --domain komoku.monentreprise.fr --email toi@exemple.fr
#   sudo ./install-serveur.sh --no-caddy            # tu as deja un reverse proxy
#   sudo ./install-serveur.sh --tunnel              # Pi derriere une box
#   sudo ./install-serveur.sh --upgrade             # mise a jour, secrets conserves
#
# Le script genere les secrets lui-meme, installe le service, verifie qu'il
# repond vraiment, et affiche a la fin la commande de fabrication de
# l'installateur client, cle comprise.

set -euo pipefail

# ----------------------------------------------------------------- reglages

DOMAIN=""
ACME_EMAIL=""
PORT="8080"
INSTALL_DIR="/opt/komoku"
DATA_DIR="/var/lib/komoku"
ENV_FILE="/etc/komoku.env"
SERVICE="komoku"
USER_NAME="komoku"
NODE_MAJOR_MIN=24
RETENTION_DAYS="30"
OFFLINE_AFTER="12"
WITH_CADDY=1
WITH_TUNNEL=0
UPGRADE=0

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  # Uniquement le bloc de commentaires en tete, et pas un numero de ligne
  # fige : la moindre ligne ajoutee plus haut decalerait tout.
  sed -n '2,/^$/{/^#/!q; s/^# \{0,1\}//; p;}' "${BASH_SOURCE[0]}"
  cat <<'EOF'

Options :
  --domain <nom>      Nom de domaine public. Requis pour le HTTPS automatique.
  --email <adresse>   Adresse pour Let's Encrypt (recommandee).
  --port <n>          Port d'ecoute interne. 8080 par defaut.
  --no-caddy          N'installe pas Caddy : tu geres le reverse proxy.
  --tunnel            Installe cloudflared (Pi sans IP publique).
  --retention <j>     Conservation des mesures. 30 jours par defaut.
  --offline-after <m> Silence avant de declarer un poste hors ligne. 12 min.
  --upgrade           Met a jour le code sans toucher aux secrets ni a la base.
  -h, --help          Cette aide.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --domain)        DOMAIN="${2:-}"; shift 2 ;;
    --email)         ACME_EMAIL="${2:-}"; shift 2 ;;
    --port)          PORT="${2:-}"; shift 2 ;;
    --retention)     RETENTION_DAYS="${2:-}"; shift 2 ;;
    --offline-after) OFFLINE_AFTER="${2:-}"; shift 2 ;;
    --no-caddy)      WITH_CADDY=0; shift ;;
    --tunnel)        WITH_TUNNEL=1; WITH_CADDY=0; shift ;;
    --upgrade)       UPGRADE=1; shift ;;
    -h|--help)       usage; exit 0 ;;
    *) echo "Option inconnue : $1" >&2; usage >&2; exit 2 ;;
  esac
done

# -------------------------------------------------------------- affichage

if [ -t 1 ]; then
  C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_DIM=$'\033[2m'; C_OFF=$'\033[0m'
else
  C_OK=""; C_WARN=""; C_ERR=""; C_DIM=""; C_OFF=""
fi

etape()   { printf '\n%s==>%s %s\n' "$C_OK" "$C_OFF" "$1"; }
info()    { printf '    %s\n' "$1"; }
discret() { printf '    %s%s%s\n' "$C_DIM" "$1" "$C_OFF"; }
avertir() { printf '%s[!]%s %s\n' "$C_WARN" "$C_OFF" "$1"; }
fatal()   { printf '%s[x]%s %s\n' "$C_ERR" "$C_OFF" "$1" >&2; exit 1; }

# ---------------------------------------------------------- pre-controles

etape "Verifications prealables"

[ "$(id -u)" -eq 0 ] || fatal "A lancer avec sudo."

command -v apt-get >/dev/null 2>&1 || \
  fatal "Ce script vise Debian, Ubuntu et Raspberry Pi OS (apt introuvable)."

[ -f "$SRC_DIR/server.js" ] || \
  fatal "server.js introuvable dans $SRC_DIR. Lance le script depuis server/deploy/."

if [ -n "$DOMAIN" ] && ! printf '%s' "$DOMAIN" | grep -Eq '^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$'; then
  fatal "Domaine invalide : $DOMAIN"
fi
if [ "$WITH_CADDY" -eq 1 ] && [ -z "$DOMAIN" ]; then
  avertir "Sans --domain, pas de HTTPS automatique : Caddy ne sera pas installe."
  WITH_CADDY=0
fi

# systemd absent en conteneur ou sous certains WSL : on installe quand meme,
# on saute simplement le demarrage du service.
HAS_SYSTEMD=1
if [ ! -d /run/systemd/system ]; then
  HAS_SYSTEMD=0
  avertir "systemd n'est pas actif ici : le service sera installe mais pas demarre."
fi

if [ "$HAS_SYSTEMD" -eq 1 ] && [ "$UPGRADE" -eq 0 ]; then
  if ss -ltn 2>/dev/null | grep -q ":$PORT "; then
    fatal "Le port $PORT est deja utilise. Choisis-en un autre avec --port."
  fi
fi

info "source      $SRC_DIR"
info "destination $INSTALL_DIR"
info "base        $DATA_DIR"
[ -n "$DOMAIN" ] && info "domaine     $DOMAIN"

# Un template LXC minimal (Proxmox, Docker) n'embarque ni curl, ni openssl,
# ni iproute2. Sans curl, le controle de sante echouerait et conclurait a tort
# que le serveur ne repond pas ; sans openssl, pas de secrets.
MANQUANTS=""
for outil in curl openssl ss; do
  command -v "$outil" >/dev/null 2>&1 || MANQUANTS="$MANQUANTS $outil"
done
if [ -n "$MANQUANTS" ]; then
  info "outils manquants :$MANQUANTS — installation"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq curl ca-certificates openssl iproute2 >/dev/null
  for outil in curl openssl; do
    command -v "$outil" >/dev/null 2>&1 || fatal "$outil n'a pas pu etre installe."
  done
fi

# ------------------------------------------------------------------- Node

etape "Node.js"

node_major() {
  command -v node >/dev/null 2>&1 || { echo 0; return; }
  node -v 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/' || echo 0
}

CURRENT="$(node_major)"
if [ "$CURRENT" -ge "$NODE_MAJOR_MIN" ]; then
  info "deja present : $(node -v)"
else
  if [ "$CURRENT" -eq 0 ]; then
    info "absent, installation de Node ${NODE_MAJOR_MIN}.x"
  else
    info "version $CURRENT trop ancienne, installation de Node ${NODE_MAJOR_MIN}.x"
  fi
  # node:sqlite est integre a Node : c'est pour lui qu'il faut une version
  # recente, et c'est aussi pourquoi il n'y a rien d'autre a compiler.
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq curl ca-certificates gnupg >/dev/null
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR_MIN}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
  CURRENT="$(node_major)"
  [ "$CURRENT" -ge "$NODE_MAJOR_MIN" ] || \
    fatal "Node ${NODE_MAJOR_MIN}+ n'a pas pu etre installe (obtenu : $(node -v 2>/dev/null || echo aucun))."
  info "installe : $(node -v)"
fi

# --------------------------------------------------------- utilisateur

etape "Compte de service"

if id "$USER_NAME" >/dev/null 2>&1; then
  info "$USER_NAME existe deja"
else
  useradd --system --home-dir "$INSTALL_DIR" --shell /usr/sbin/nologin "$USER_NAME"
  info "$USER_NAME cree"
fi

# ------------------------------------------------------------- fichiers

etape "Installation du code"

mkdir -p "$INSTALL_DIR" "$DATA_DIR"
# --delete sur le code seulement : la base vit ailleurs, elle n'est jamais
# touchee par une mise a jour.
for item in server.js package.json lib public scripts; do
  [ -e "$SRC_DIR/$item" ] || continue
  rm -rf "${INSTALL_DIR:?}/$item"
  cp -r "$SRC_DIR/$item" "$INSTALL_DIR/"
done
chown -R "$USER_NAME:$USER_NAME" "$INSTALL_DIR" "$DATA_DIR"
chmod 750 "$DATA_DIR"
info "code copie dans $INSTALL_DIR"

# -------------------------------------------------------------- secrets

etape "Secrets"

secret() { openssl rand -base64 24 | tr -d '\n' | tr '+/' '-_' | tr -d '='; }

if [ -f "$ENV_FILE" ]; then
  info "$ENV_FILE existe : secrets conserves"
  # shellcheck disable=SC1090
  API_KEY="$(grep -E '^API_KEY=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
  DASH_PASS="$(grep -E '^DASH_PASS=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
  [ -n "$API_KEY" ] || fatal "API_KEY absente de $ENV_FILE. Corrige-le ou supprime-le."
  NOUVEAUX=0
else
  command -v openssl >/dev/null 2>&1 || fatal "openssl est requis pour generer les secrets."
  API_KEY="$(secret)"
  DASH_PASS="$(secret)"
  NOUVEAUX=1
  info "nouveaux secrets generes"
fi

PUBLIC_URL="http://127.0.0.1:$PORT"
[ -n "$DOMAIN" ] && PUBLIC_URL="https://$DOMAIN"

umask 077
cat > "$ENV_FILE" <<EOF
# Genere par install-serveur.sh le $(date -Is)
# Ce fichier contient des secrets : ne le versionne pas.
API_KEY=$API_KEY
DASH_PASS=$DASH_PASS
PORT=$PORT
HOST=127.0.0.1
DB_PATH=$DATA_DIR/komoku.db
RETENTION_DAYS=$RETENTION_DAYS
OFFLINE_AFTER_MINUTES=$OFFLINE_AFTER
SESSION_DAYS=14
VPN_REQUIRED=false
EOF
chmod 600 "$ENV_FILE"
chown root:root "$ENV_FILE"
info "$ENV_FILE ecrit (600, root)"

# -------------------------------------------------------------- service

etape "Service systemd"

cat > "/etc/systemd/system/$SERVICE.service" <<EOF
[Unit]
Description=Komoku - collecte et tableau de bord du parc informatique
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER_NAME
Group=$USER_NAME
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node $INSTALL_DIR/server.js
Restart=always
RestartSec=5

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=true
LockPersonality=true
MemoryDenyWriteExecute=true
ReadWritePaths=$DATA_DIR

StandardOutput=journal
StandardError=journal
SyslogIdentifier=$SERVICE

[Install]
WantedBy=multi-user.target
EOF
info "unite ecrite"

if [ "$HAS_SYSTEMD" -eq 1 ]; then
  systemctl daemon-reload
  systemctl enable "$SERVICE" >/dev/null 2>&1 || true
  systemctl restart "$SERVICE"
  info "service demarre"
else
  avertir "Demarrage saute (pas de systemd). Pour essayer a la main :"
  discret "  sudo -u $USER_NAME env \$(grep -v '^#' $ENV_FILE | xargs) node $INSTALL_DIR/server.js"
fi

# ------------------------------------------------------- controle de sante

etape "Controle de sante"

if [ "$HAS_SYSTEMD" -eq 1 ]; then
  OK=0
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
      OK=1; break
    fi
    sleep 1
  done
  if [ "$OK" -eq 1 ]; then
    info "le serveur repond sur 127.0.0.1:$PORT"
  else
    printf '\n'
    journalctl -u "$SERVICE" -n 25 --no-pager || true
    fatal "Le serveur ne repond pas. Journal ci-dessus."
  fi
else
  discret "ignore : service non demarre"
fi

# ----------------------------------------------------------------- Caddy

if [ "$WITH_CADDY" -eq 1 ]; then
  etape "HTTPS avec Caddy"

  if ! command -v caddy >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl >/dev/null
    curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
      | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
      > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq
    apt-get install -y -qq caddy >/dev/null
    info "Caddy installe"
  else
    info "Caddy deja present"
  fi

  # On n'ecrase jamais le Caddyfile existant : on depose un fichier a part et
  # on s'assure qu'il est importe. Une autre application peut deja servir sur
  # cette machine.
  mkdir -p /etc/caddy/Caddyfile.d
  cat > /etc/caddy/Caddyfile.d/komoku.caddy <<EOF
$DOMAIN {
	reverse_proxy 127.0.0.1:$PORT
	encode zstd gzip
	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Content-Type-Options "nosniff"
		X-Frame-Options "DENY"
		Referrer-Policy "no-referrer"
		-Server
	}
}
EOF
  touch /etc/caddy/Caddyfile
  if ! grep -q 'Caddyfile.d' /etc/caddy/Caddyfile; then
    printf '\nimport Caddyfile.d/*\n' >> /etc/caddy/Caddyfile
  fi
  [ -n "$ACME_EMAIL" ] && ! grep -q 'email' /etc/caddy/Caddyfile && \
    sed -i "1i {\n\temail $ACME_EMAIL\n}" /etc/caddy/Caddyfile

  if caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
    systemctl reload caddy 2>/dev/null || systemctl restart caddy
    info "Caddy recharge pour $DOMAIN"
    discret "le certificat peut prendre une minute a etre emis"
  else
    avertir "La configuration Caddy est refusee. Verifie /etc/caddy/Caddyfile."
  fi
fi

# ------------------------------------------------------ tunnel Cloudflare

if [ "$WITH_TUNNEL" -eq 1 ]; then
  etape "Tunnel Cloudflare"
  if ! command -v cloudflared >/dev/null 2>&1; then
    ARCH="$(dpkg --print-architecture)"
    curl -fsSL -o /tmp/cloudflared.deb \
      "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH}.deb"
    dpkg -i /tmp/cloudflared.deb >/dev/null
    rm -f /tmp/cloudflared.deb
    info "cloudflared installe"
  else
    info "cloudflared deja present"
  fi
  # La suite exige une authentification interactive au compte Cloudflare :
  # elle ne peut pas etre scriptee a l'aveugle.
  cat <<EOF

    A faire une seule fois, en interactif :
      cloudflared tunnel login
      cloudflared tunnel create komoku
      cloudflared tunnel route dns komoku <ton-domaine>
      cloudflared tunnel --url http://127.0.0.1:$PORT run komoku
      cloudflared service install

EOF
fi

# ----------------------------------------------------------------- resume

printf '\n%s============================================================%s\n' "$C_OK" "$C_OFF"
printf '%s Komoku est installe.%s\n' "$C_OK" "$C_OFF"
printf '%s============================================================%s\n\n' "$C_OK" "$C_OFF"

printf '  Tableau de bord : %s\n' "$PUBLIC_URL"
if [ "$NOUVEAUX" -eq 1 ]; then
  printf '  Mot de passe    : %s\n' "$DASH_PASS"
  printf '\n  %sNote-le maintenant : il n%s%sapparaitra plus.%s\n' "$C_WARN" "'" "" "$C_OFF"
else
  printf '  Mot de passe    : inchange (voir %s)\n' "$ENV_FILE"
fi

cat <<EOF

  Installateur client, a fabriquer sur un poste Windows depuis le depot :

    .\\packaging\\build-client.ps1 -ServerUrl $PUBLIC_URL -ApiKey "$API_KEY"

  Commandes utiles :
    systemctl status $SERVICE
    journalctl -u $SERVICE -f
    $ENV_FILE          reglages du serveur

EOF

if [ -z "$DOMAIN" ] && [ "$WITH_TUNNEL" -eq 0 ]; then
  avertir "Le serveur n'ecoute que sur 127.0.0.1 : seuls les postes de cette"
  avertir "machine peuvent l'atteindre. Ajoute --domain, --tunnel, ou place"
  avertir "ton propre reverse proxy devant."
fi
