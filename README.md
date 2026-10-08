# Komoku

Supervision légère d'un parc de PC Windows. Chaque poste remonte son état
toutes les trois minutes ; tu ouvres une page web et tu vois tout le parc.

Pensé pour que les collaborateurs n'aient **rien** à faire : l'agent s'installe
une fois, tourne en tâche de fond sous le compte SYSTEM, et ne montre aucune
fenêtre.

## Ce que tu vois

| | |
|---|---|
| **Matériel** | modèle, numéro de série, processeur, carte graphique, RAM installée |
| **Charge** | CPU, mémoire, GPU, occupation de chaque disque, avec 30 jours d'historique |
| **Réseau** | IP locale de chaque carte, IP publique, passerelle, DNS, SSID Wi-Fi |
| **VPN** | connecté ou non, et avec quel client (WireGuard, OpenVPN, NordVPN, Fortinet, AnyConnect, Tailscale… 20 clients reconnus) |
| **Sécurité** | antivirus actif ou non, signatures à jour, pare-feu, BitLocker, dernier correctif Windows, redémarrage en attente |
| **Divers** | utilisateur connecté, durée depuis le dernier démarrage, batterie, santé SMART des disques, programmes les plus gourmands |

Le tableau de bord classe les postes tout seul : **Problème**, **Attention**,
**À noter**, **Normal**, **Hors ligne** — avec, pour chacun, la phrase qui
explique pourquoi.

## Trois vues

**Carte** (par défaut) — deux volets. En haut, un bandeau d'une ligne par poste :
voyant, nom, utilisateur, CPU, RAM, disque, VPN, dernier contact. Les postes en
difficulté remontent en tête. En bas, le parc en plan radial : le serveur au
centre, chaque poste relié par un lien dont la couleur suit son état, et trois
micro-jauges par poste. Les liens actifs sont animés, les postes muets en
pointillé éteint.

**Cartes** — une vignette détaillée par poste, avec les jauges en grand.

**Tableau** — toutes les valeurs en colonnes triables. C'est aussi la vue
accessible : rien n'y dépend de la couleur.

Le choix est mémorisé dans le navigateur. Un clic n'importe où — ligne, nœud,
vignette, ligne de tableau — ouvre le détail du poste : anomalies, courbes de
charge sur 6 h / 24 h / 7 j, disques, réseau, sécurité, matériel, programmes
les plus gourmands.

## Architecture

```
  Poste 1  ─┐
  Poste 2  ─┤   HTTPS + clé API        ┌─────────────┐      mot de passe
  Poste 3  ─┼──────────────────────────▶│ ton VPS     │◀──────────────────  toi
  Poste …  ─┘   toutes les 3 min       │ Node+SQLite │      (navigateur)
                                        └─────────────┘
```

- **Agent** — un script PowerShell. Aucune dépendance : PowerShell 5.1 est déjà
  sur tous les Windows 10 et 11.
- **Serveur** — Node 24, **aucune dépendance npm**. SQLite est intégré à Node
  (`node:sqlite`), donc rien à compiler, rien à installer, pas de `npm install`
  qui échoue sur un VPS sans compilateur.
- **Tableau de bord** — HTML et JavaScript natifs, servis par le même serveur.

---

## 1. Installer le serveur

Il te faut un VPS joignable depuis Internet (tes postes sont en partie en
télétravail) avec **Node 24 ou plus**, et un nom de domaine qui pointe dessus.

### Option la plus courte — le script d'installation

Sur une Debian, une Ubuntu ou un conteneur LXC Proxmox :

```bash
cd server/deploy
sudo ./install-serveur.sh --domain komoku.monentreprise.fr --email toi@exemple.fr
```

Il installe Node si besoin, crée le compte de service, **génère les secrets
lui-même**, met en place le service systemd, obtient le certificat HTTPS via
Caddy, vérifie que le serveur répond vraiment, puis affiche la commande de
fabrication de l'installateur client — clé comprise, donc sans copier-coller
de secret.

| Option | Effet |
|---|---|
| `--tunnel` | installe cloudflared : HTTPS sans IP publique ni port ouvert, pour un Pi ou un serveur derrière une box |
| `--no-caddy` | tu as déjà un reverse proxy devant |
| `--upgrade` | met à jour le code sans toucher aux secrets ni à la base |

Sur Proxmox, un conteneur LXC Debian non privilégié suffit : 1 vCPU, 512 Mo de
RAM, 16 Go de disque. La sauvegarde se fait par `vzdump`, sans script
applicatif — SQLite en mode WAL se répare seul après un instantané à chaud.

Les deux sections suivantes décrivent la même installation à la main.

### Génère les deux secrets

```bash
node -e "console.log('API_KEY  =', require('crypto').randomBytes(24).toString('base64url')); console.log('DASH_PASS=', require('crypto').randomBytes(12).toString('base64url'))"
```

`API_KEY` sera partagée par tous les agents. `DASH_PASS` est ton mot de passe
d'accès au tableau de bord.

### Option A — Docker (le plus simple)

```bash
cd server
cp .env.example .env     # colle tes deux secrets dedans
docker compose up -d
```

### Option B — systemd, sans Docker

Les commandes exactes sont en tête de [`server/deploy/komoku.service`](server/deploy/komoku.service).
En résumé : copier `server/` dans `/opt/komoku`, mettre la configuration dans
`/etc/komoku.env`, activer le service.

### Le HTTPS

Dans les deux cas le serveur n'écoute que sur `127.0.0.1` : c'est un reverse
proxy qui l'expose. [`server/deploy/Caddyfile`](server/deploy/Caddyfile) fait le
travail en six lignes, certificat compris.

```bash
sudo cp server/deploy/Caddyfile /etc/caddy/Caddyfile   # change le domaine
sudo systemctl reload caddy
```

Ouvre `https://komoku.ton-domaine.fr` : la page de connexion t'attend.

> **N'expose jamais le serveur en HTTP simple sur Internet.** La clé API et ton
> mot de passe circuleraient en clair.

---

## 2. Installer l'agent sur un poste

Le plus simple est de fabriquer un exécutable qui porte déjà l'URL et la clé :

```powershell
.packaginguild-client.ps1 -ServerUrl https://komoku.monentreprise.fr -ApiKey "ta-clé"
```

Tu obtiens `distInstaller-Komoku.exe` et `distDesinstaller-Komoku.exe`. Le
collaborateur double-clique, accepte l'élévation, et voit un message explicite.
Il n'a rien à saisir.

> Ces exécutables ne sont pas signés : SmartScreen avertira, et certains
> antivirus peuvent les bloquer. Pour un déploiement à l'échelle, signe-les ou
> distribue-les par GPO.

Sinon, à la main : copie le dossier `agent/` sur le poste (clé USB, partage réseau, GPO…), ouvre
**PowerShell en administrateur**, et lance :

```powershell
.\install.ps1 -ServerUrl https://komoku.ton-domaine.fr -ApiKey "ta-cle-api" -Label "Poste accueil"
```

Le script copie l'agent dans `C:\ProgramData\Komoku`, restreint la lecture de la
clé API à SYSTEM et aux administrateurs, crée la tâche planifiée, puis fait un
envoi de test et te dit s'il est passé.

Le poste apparaît dans le tableau de bord en moins d'une minute.

| Option | Effet |
|---|---|
| `-Label "…"` | nom affiché. Sans cette option, le nom réseau du poste est utilisé |
| `-IntervalMinutes 5` | espace les envois (3 min par défaut) |
| `-NoPublicIp` | n'interroge aucun service externe pour connaître l'IP publique |
| `-NoGpuLoad` | ne mesure pas la charge GPU |

### Désinstaller

```powershell
.\uninstall.ps1
```

Puis retire le poste du tableau de bord via **Retirer du parc**, dans son détail.

### Vérifier un poste à la main

```powershell
powershell -ExecutionPolicy Bypass -File C:\ProgramData\Komoku\komoku-agent.ps1 -Show
```

Affiche le rapport complet dans la console sans rien envoyer. Le journal des
envois est dans `C:\ProgramData\Komoku\agent.log`.

---

## Essayer sans installer quoi que ce soit

```bash
cd server
node scripts/seed.js                       # 6 postes fictifs + 24 h d'historique
API_KEY=test DASH_PASS=test node server.js
```

Puis `http://127.0.0.1:8080`, mot de passe `test`.
Pour nettoyer : `node scripts/seed.js --clean` (ne touche qu'aux postes fictifs).

---

## Réglages

Tout se passe dans `.env` côté serveur :

| Variable | Défaut | Rôle |
|---|---|---|
| `OFFLINE_AFTER_MINUTES` | `12` | délai de silence avant de marquer un poste hors ligne. Garde au moins trois fois l'intervalle des agents |
| `RETENTION_DAYS` | `30` | durée de conservation des courbes |
| `VPN_REQUIRED` | `false` | signaler les postes sans VPN. À n'activer que si le VPN est vraiment obligatoire chez toi |
| `SESSION_DAYS` | `14` | durée d'une session du tableau de bord |

Les seuils d'alerte (disque plein, RAM saturée…) sont regroupés dans l'objet
`SEUILS`, en haut de [`server/lib/health.js`](server/lib/health.js).

Changer `DASH_PASS` déconnecte immédiatement toutes les sessions ouvertes : le
secret de session en dérive.

---

## Coût en ressources

Mesuré sur un Latitude 5550 sous Windows 11 :

| | |
|---|---|
| Durée d'un relevé | **~4 s**, dont 0,3 s pour le GPU |
| Taille d'un envoi | ~3,4 Ko |
| Trafic par poste | ~1,6 Mo par mois |
| Base pour 100 postes sur 30 jours | quelques dizaines de Mo |

L'agent sépare ce qui bouge de ce qui ne bouge pas : les métriques live sont
relevées à chaque passage, l'inventaire (modèle, antivirus, BitLocker,
correctifs) est mis en cache une heure. Sans cette séparation, un relevé
coûterait 30 secondes au lieu de 4.

---

## Sécurité

- Les agents s'authentifient par clé API ; le tableau de bord par mot de passe
  et cookie de session signé (HMAC-SHA256, `HttpOnly`, `SameSite=Lax`,
  `Secure` dès que la requête arrive en HTTPS).
- Les comparaisons de secrets se font à temps constant.
- Dix tentatives de connexion ratées par IP et par quart d'heure, puis blocage.
- L'agent n'expose **aucun port** et n'accepte aucune commande : il ne fait que
  sortir. Impossible de piloter un poste depuis le serveur.
- La clé API sur le poste n'est lisible que par SYSTEM et les administrateurs.
- Le serveur ne sert que le contenu de `public/`, et refuse les chemins qui
  tentent d'en sortir.

### Vie privée

Komoku relève l'état des machines, pas l'activité des personnes : pas de frappe
clavier, pas de capture d'écran, pas d'historique de navigation, pas de liste
des documents ouverts. Les deux données qui touchent à l'usage sont
l'**identifiant de session Windows** et les **six programmes les plus
gourmands** — tous deux désactivables (`collectProcesses` dans
`C:\ProgramData\Komoku\komoku.config.json`).

En France, un outil de supervision des postes doit être porté à la connaissance
des salariés et inscrit au registre des traitements ; les représentants du
personnel sont informés et consultés quand il en existe. Rien d'insurmontable —
une note d'information écrite suffit dans la plupart des cas — mais c'est à
faire **avant** le déploiement, pas après.

---

## Dépannage

**Le poste n'apparaît pas.** Regarde `C:\ProgramData\Komoku\agent.log` :

| Message | Cause |
|---|---|
| `Envoi OK` | tout va bien, le souci est ailleurs |
| `Cle API refusee (HTTP 401)` | `API_KEY` du serveur ≠ clé dans `komoku.config.json` |
| `Echec envoi` répété | serveur injoignable : DNS, pare-feu, proxy d'entreprise |
| rien du tout | la tâche ne tourne pas : vérifie `Get-ScheduledTask "Komoku Agent"` |

**Un poste reste « Hors ligne » alors qu'il est allumé.** Son dernier envoi date
de plus de `OFFLINE_AFTER_MINUTES`. Un portable en veille remonte hors ligne,
c'est normal.

**`install.ps1` affiche « Restriction des droits impossible ».** Le fichier de
configuration contient la clé API : s'il n'est pas restreint, n'importe quel
utilisateur du poste peut la lire. Le script le dit explicitement et poursuit.
Sur un poste joint à un domaine qui ne joint pas son contrôleur, la pose des
droits peut échouer ; relance l'installation une fois le poste rattaché, ou
restreins les droits à la main (Propriétés > Sécurité : ne laisser que SYSTEM
et Administrateurs).

**La charge GPU reste vide.** Les compteurs GPU exigent un pilote WDDM 2.0
(Windows 10 1709 ou plus). Les machines virtuelles et certaines cartes anciennes
n'en exposent aucun — le reste du rapport fonctionne quand même.

**`node: command not found` ou erreur `node:sqlite`.** Ton Node est trop ancien.
`node --version` doit afficher 24 ou plus.

---

## Organisation du dépôt

```
agent/
  komoku-agent.ps1      collecte et envoi (PowerShell 5.1)
  install.ps1           installation : copie, config, tâche planifiée
  uninstall.ps1         désinstallation
server/
  server.js             API + service des fichiers statiques
  lib/health.js         règles d'alerte et seuils
  lib/normalize.js      remise en forme des rapports reçus
  public/               tableau de bord et page de connexion
  scripts/seed.js       jeu de données de démonstration
  deploy/               install-serveur.sh, unité systemd, Caddyfile
  Dockerfile, docker-compose.yml
packaging/
  build-client.ps1      fabrique les .exe client (IExpress)
dist/                   les exécutables produits
```
