<#
.SYNOPSIS
    Installe le serveur Komoku sur une machine Windows (NUC, mini-PC, poste
    fixe allume en permanence).

.DESCRIPTION
    Equivalent Windows de deploy/install-serveur.sh. Il installe le code, cree
    les secrets, met en place une tache planifiee qui fait office de service,
    desactive la mise en veille, verifie que le serveur repond vraiment, puis
    affiche la commande de fabrication de l'installateur client.

    Le serveur tourne sous SYSTEM, demarre sans session ouverte, et redemarre
    tout seul apres une mise a jour Windows ou un plantage.

    A lancer depuis une invite PowerShell *administrateur*.

.PARAMETER LanAccess
    Ecoute sur toutes les interfaces et ouvre le port dans le pare-feu, pour
    que les postes du reseau local joignent le serveur. Sans cette option, le
    serveur n'ecoute que sur 127.0.0.1 : utile uniquement derriere un tunnel
    ou un reverse proxy local.

.PARAMETER Tunnel
    Installe cloudflared, pour exposer le serveur en HTTPS sans IP publique
    ni ouverture de port sur la box. Necessaire pour les postes en
    teletravail.

.PARAMETER PublicUrl
    URL par laquelle les agents joindront le serveur, si elle differe de
    l'adresse locale (tunnel, reverse proxy, nom de domaine interne).

.PARAMETER Upgrade
    Met a jour le code sans toucher aux secrets ni a la base.

.EXAMPLE
    .\install-serveur-windows.ps1 -LanAccess

.EXAMPLE
    .\install-serveur-windows.ps1 -Tunnel -PublicUrl https://komoku.monentreprise.fr
#>
[CmdletBinding()]
param(
    [int]$Port = 8080,
    [switch]$LanAccess,
    [switch]$Tunnel,
    [string]$PublicUrl = '',
    [int]$RetentionDays = 30,
    [int]$OfflineAfterMinutes = 12,
    [switch]$Upgrade,
    [switch]$KeepSleep
)

$ErrorActionPreference = 'Stop'

$TaskName = 'Komoku Serveur'
$InstallDir = Join-Path $env:ProgramFiles 'Komoku'
$DataDir = Join-Path $env:ProgramData 'Komoku-Server'
$ConfigPath = Join-Path $DataDir 'serveur.config.json'
$LauncherPath = Join-Path $InstallDir 'start-serveur.ps1'
$SrcDir = Join-Path (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Definition)) 'server'

$SID_SYSTEM = 'S-1-5-18'
$SID_ADMINS = 'S-1-5-32-544'

function Etape { param([string]$T) Write-Host ''; Write-Host "==> $T" -ForegroundColor Cyan }
function Info { param([string]$T) Write-Host "    $T" }
function Avertir { param([string]$T) Write-Host "[!] $T" -ForegroundColor Yellow }

# ------------------------------------------------------------ verifications

Etape 'Verifications prealables'

$principal = New-Object Security.Principal.WindowsPrincipal(
    [Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'A lancer depuis une invite PowerShell administrateur.'
}

if (-not (Test-Path (Join-Path $SrcDir 'server.js'))) {
    throw "server.js introuvable dans $SrcDir. Lance le script depuis packaging/ du depot."
}

$node = Get-Command node -ErrorAction SilentlyContinue
$majeure = 0
if ($node) {
    $v = (& node -v) -replace '^v(\d+).*', '$1'
    [void][int]::TryParse($v, [ref]$majeure)
}
if ($majeure -lt 24) {
    $dit = if ($node) { "version $majeure" } else { 'absent' }
    Avertir "Node.js $dit : il faut Node 24 ou plus (le serveur utilise node:sqlite)."
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        Info 'Installation via winget...'
        & winget install --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements | Out-Null
        $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                    [Environment]::GetEnvironmentVariable('Path', 'User')
        $node = Get-Command node -ErrorAction SilentlyContinue
        if ($node) { $v = (& node -v) -replace '^v(\d+).*', '$1'; [void][int]::TryParse($v, [ref]$majeure) }
    }
    if ($majeure -lt 24) {
        throw "Installe Node 24+ depuis https://nodejs.org puis relance ce script."
    }
}
Info "Node $(& node -v)"

if (-not $Upgrade) {
    $occupe = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($occupe) { throw "Le port $Port est deja utilise. Choisis-en un autre avec -Port." }
}

$bind = if ($LanAccess) { '0.0.0.0' } else { '127.0.0.1' }
Info "ecoute      $bind`:$Port"
Info "code        $InstallDir"
Info "donnees     $DataDir"

# -------------------------------------------------------------- fichiers

Etape 'Installation du code'

New-Item -ItemType Directory -Path $InstallDir, $DataDir -Force | Out-Null
foreach ($item in @('server.js', 'package.json', 'lib', 'public', 'scripts')) {
    $src = Join-Path $SrcDir $item
    if (-not (Test-Path $src)) { continue }
    $dst = Join-Path $InstallDir $item
    if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
    Copy-Item $src $dst -Recurse -Force
}
Info "code copie"

# --------------------------------------------------------------- secrets

Etape 'Secrets'

function New-Secret {
    $o = New-Object byte[] 24
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($o)
    return ([Convert]::ToBase64String($o) -replace '\+', '-' -replace '/', '_' -replace '=', '')
}

$nouveaux = $true
$apiKey = $null
$dashPass = $null

if (Test-Path $ConfigPath) {
    try {
        $ancien = Get-Content $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($ancien.API_KEY -and $ancien.DASH_PASS) {
            $apiKey = $ancien.API_KEY
            $dashPass = $ancien.DASH_PASS
            $nouveaux = $false
            Info 'configuration existante : secrets conserves'
        }
    } catch {
        Avertir "Configuration existante illisible, de nouveaux secrets seront generes."
    }
}
if ($nouveaux) {
    $apiKey = New-Secret
    $dashPass = New-Secret
    Info 'nouveaux secrets generes'
}

if (-not $PublicUrl) {
    $PublicUrl = if ($LanAccess) {
        $ip = (Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway } |
               Select-Object -First 1).IPv4Address.IPAddress
        if ($ip) { "http://$ip`:$Port" } else { "http://127.0.0.1`:$Port" }
    } else { "http://127.0.0.1`:$Port" }
}

$config = [ordered]@{
    API_KEY               = $apiKey
    DASH_PASS             = $dashPass
    PORT                  = "$Port"
    HOST                  = $bind
    DB_PATH               = (Join-Path $DataDir 'komoku.db')
    RETENTION_DAYS        = "$RetentionDays"
    OFFLINE_AFTER_MINUTES = "$OfflineAfterMinutes"
    SESSION_DAYS          = '14'
    VPN_REQUIRED          = 'false'
    NOTIFY_SITE_NAME      = 'Komoku'
    NOTIFY_SITE_URL       = $PublicUrl
}
$config | ConvertTo-Json -Depth 3 | Set-Content $ConfigPath -Encoding UTF8

# Meme durcissement que pour la cle de l'agent : SID plutot que noms de
# comptes (invalides sur un Windows francais), icacls plutot que Set-Acl (qui
# echoue si le poste ne joint pas son controleur de domaine), et surtout on
# ACCORDE avant de RETIRER, pour ne jamais laisser le fichier sans acces.
$droitsPoses = $false
$pref = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
    & icacls $ConfigPath /grant "*${SID_SYSTEM}:(F)" "*${SID_ADMINS}:(F)" | Out-Null
    & icacls $ConfigPath /inheritance:r | Out-Null
    foreach ($ace in (Get-Acl $ConfigPath).GetAccessRules(
            $true, $true, [Security.Principal.SecurityIdentifier])) {
        $sid = $ace.IdentityReference.Value
        if ($sid -notin @($SID_SYSTEM, $SID_ADMINS)) {
            & icacls $ConfigPath /remove:g "*$sid" | Out-Null
        }
    }
    $presents = @((Get-Acl $ConfigPath).GetAccessRules(
        $true, $true, [Security.Principal.SecurityIdentifier]) |
        ForEach-Object { $_.IdentityReference.Value } | Sort-Object -Unique)
    $manquants = @(@($SID_SYSTEM, $SID_ADMINS) | Where-Object { $_ -notin $presents })
    $intrus = @($presents | Where-Object { $_ -notin @($SID_SYSTEM, $SID_ADMINS) })
    if ($manquants.Count -eq 0 -and $intrus.Count -eq 0) {
        $droitsPoses = $true
        Info 'droits : SYSTEM + administrateurs uniquement'
    } else {
        & icacls $ConfigPath /reset | Out-Null
        Avertir "Restriction incomplete, heritage restaure. Manquants : $($manquants -join ', ') ; en trop : $($intrus -join ', ')"
    }
} catch {
    & icacls $ConfigPath /reset | Out-Null
    Avertir "Restriction des droits impossible, heritage restaure : $($_.Exception.Message)"
} finally {
    $ErrorActionPreference = $pref
}
if (-not $droitsPoses) {
    Avertir "$ConfigPath reste lisible par les utilisateurs de ce poste."
}

# -------------------------------------------------------------- lanceur

Etape 'Lanceur'

$lanceur = @"
# Genere par install-serveur-windows.ps1 : ne pas modifier a la main.
# Lit la configuration protegee, la place dans l'environnement, et demarre le
# serveur. Seul SYSTEM peut lire ce fichier de configuration.
`$ErrorActionPreference = 'Stop'
`$cfg = Get-Content '$ConfigPath' -Raw -Encoding UTF8 | ConvertFrom-Json
foreach (`$p in `$cfg.PSObject.Properties) {
    Set-Item -Path ('env:' + `$p.Name) -Value ([string]`$p.Value)
}
Set-Location '$InstallDir'
& node '$InstallDir\server.js'
"@
Set-Content -Path $LauncherPath -Value $lanceur -Encoding UTF8
Info $LauncherPath

# ------------------------------------------------------------ veille

if (-not $KeepSleep) {
    Etape 'Mise en veille'
    # Un serveur qui s'endort, c'est tout le parc qui passe hors ligne.
    & powercfg /change standby-timeout-ac 0 2>&1 | Out-Null
    & powercfg /change hibernate-timeout-ac 0 2>&1 | Out-Null
    & powercfg /change disk-timeout-ac 0 2>&1 | Out-Null
    Info 'veille, hibernation et arret des disques desactives sur secteur'
}

# ---------------------------------------------------------------- tache

Etape 'Tache planifiee'

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$LauncherPath`""

$trDemarrage = New-ScheduledTaskTrigger -AtStartup
$trDemarrage.Delay = 'PT30S'

# Repetition toutes les 5 min avec IgnoreNew : tant que le serveur tourne, le
# declenchement est ignore ; s'il est mort, il repart. C'est le chien de garde,
# sans dependance exterieure.
$trChien = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 5)

$princ = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\SYSTEM' -RunLevel Highest

# ExecutionTimeLimit a zero : sans cela, Windows tuerait le serveur au bout de
# trois jours.
$reglages = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $TaskName `
    -Description 'Serveur Komoku : collecte et tableau de bord du parc.' `
    -Action $action -Trigger @($trDemarrage, $trChien) `
    -Principal $princ -Settings $reglages | Out-Null
Info "« $TaskName », au demarrage + surveillance toutes les 5 min, sous SYSTEM"

Start-ScheduledTask -TaskName $TaskName

# -------------------------------------------------------------- pare-feu

if ($LanAccess) {
    Etape 'Pare-feu'
    $regle = 'Komoku Serveur'
    Get-NetFirewallRule -DisplayName $regle -ErrorAction SilentlyContinue |
        Remove-NetFirewallRule -ErrorAction SilentlyContinue
    New-NetFirewallRule -DisplayName $regle -Direction Inbound -Action Allow `
        -Protocol TCP -LocalPort $Port -Profile Domain,Private | Out-Null
    Info "port $Port ouvert sur les profils Domaine et Prive (pas Public)"
}

# ------------------------------------------------------- controle de sante

Etape 'Controle de sante'

$ok = $false
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    try {
        $r = Invoke-WebRequest "http://127.0.0.1:$Port/api/health" -TimeoutSec 2 -UseBasicParsing
        if ($r.StatusCode -eq 200) { $ok = $true; break }
    } catch {}
}
if ($ok) {
    Info "le serveur repond sur 127.0.0.1:$Port"
} else {
    Avertir 'Le serveur ne repond pas encore. Diagnostic :'
    Write-Host "    powershell -ExecutionPolicy Bypass -File `"$LauncherPath`"" -ForegroundColor DarkGray
    Write-Host '    (lance le serveur au premier plan et affiche l''erreur)' -ForegroundColor DarkGray
}

# ------------------------------------------------------------- cloudflared

if ($Tunnel) {
    Etape 'Tunnel Cloudflare'
    if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
        if (Get-Command winget -ErrorAction SilentlyContinue) {
            & winget install --id Cloudflare.cloudflared --silent `
                --accept-package-agreements --accept-source-agreements | Out-Null
            Info 'cloudflared installe'
        } else {
            Avertir 'winget absent : installe cloudflared depuis https://github.com/cloudflare/cloudflared/releases'
        }
    } else { Info 'cloudflared deja present' }

    Write-Host ''
    Write-Host '    A faire une seule fois, en interactif :' -ForegroundColor DarkGray
    Write-Host '      cloudflared tunnel login' -ForegroundColor DarkGray
    Write-Host '      cloudflared tunnel create komoku' -ForegroundColor DarkGray
    Write-Host '      cloudflared tunnel route dns komoku <ton-domaine>' -ForegroundColor DarkGray
    Write-Host "      cloudflared tunnel --url http://127.0.0.1:$Port run komoku" -ForegroundColor DarkGray
    Write-Host '      cloudflared service install' -ForegroundColor DarkGray
}

# ---------------------------------------------------------------- resume

Write-Host ''
Write-Host '============================================================' -ForegroundColor Green
Write-Host ' Komoku est installe.' -ForegroundColor Green
Write-Host '============================================================' -ForegroundColor Green
Write-Host ''
Write-Host "  Tableau de bord : $PublicUrl"
if ($nouveaux) {
    Write-Host "  Mot de passe    : $dashPass"
    Write-Host ''
    Avertir 'Note-le maintenant : il ne sera plus affiche.'
} else {
    Write-Host "  Mot de passe    : inchange (voir $ConfigPath)"
}
Write-Host ''
Write-Host '  Installateur client, a fabriquer depuis le depot :'
Write-Host ''
Write-Host "    .\packaging\build-client.ps1 -ServerUrl $PublicUrl -ApiKey `"$apiKey`"" -ForegroundColor White
Write-Host ''
Write-Host '  Commandes utiles :'
Write-Host "    Get-ScheduledTask '$TaskName'"
Write-Host "    Get-ScheduledTaskInfo '$TaskName'"
Write-Host "    $ConfigPath   (reglages et alertes, admin requis)"
Write-Host ''

if (-not $LanAccess -and -not $Tunnel) {
    Avertir 'Le serveur n''ecoute que sur 127.0.0.1 : aucun autre poste ne peut'
    Avertir 'l''atteindre. Relance avec -LanAccess, ou -Tunnel pour le teletravail.'
}
