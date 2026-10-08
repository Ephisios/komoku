<#
.SYNOPSIS
    Installe l'agent Komoku sur ce poste.

.DESCRIPTION
    Copie l'agent dans C:\ProgramData\Komoku, ecrit sa configuration et cree une
    tache planifiee qui l'execute sous le compte SYSTEM, au demarrage puis a
    intervalle regulier.

    A lancer depuis une invite PowerShell *administrateur*.

.PARAMETER ServerUrl
    URL de base du serveur Komoku, par exemple https://komoku.monentreprise.fr

.PARAMETER ApiKey
    Cle API du serveur (variable API_KEY cote serveur).

.PARAMETER Label
    Nom lisible du poste affiche dans le tableau de bord. Optionnel :
    par defaut le nom reseau de la machine est utilise.

.PARAMETER IntervalMinutes
    Frequence d'envoi, en minutes. 3 par defaut.

.PARAMETER NoPublicIp
    N'interroge pas de service externe pour connaitre l'IP publique du poste.

.PARAMETER NoGpuLoad
    Ne mesure pas la charge GPU (gagne environ 0,3 s par passage).

.EXAMPLE
    .\install.ps1 -ServerUrl https://komoku.exemple.fr -ApiKey "xxxx" -Label "Poste accueil"
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ServerUrl,
    [Parameter(Mandatory = $true)][string]$ApiKey,
    [string]$Label = '',
    [int]$IntervalMinutes = 3,
    [switch]$NoPublicIp,
    [switch]$NoGpuLoad
)

$ErrorActionPreference = 'Stop'

$TaskName = 'Komoku Agent'
$InstallDir = Join-Path $env:ProgramData 'Komoku'
$AgentPath = Join-Path $InstallDir 'komoku-agent.ps1'
$ConfigPath = Join-Path $InstallDir 'komoku.config.json'
$SourceAgent = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Definition) 'komoku-agent.ps1'

function Assert-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($id)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Cette installation requiert une invite PowerShell lancee en administrateur.'
    }
}

Assert-Admin

if (-not (Test-Path $SourceAgent)) {
    throw "komoku-agent.ps1 est introuvable a cote de ce script ($SourceAgent)."
}
if ($IntervalMinutes -lt 1 -or $IntervalMinutes -gt 1440) {
    throw 'IntervalMinutes doit etre comprise entre 1 et 1440.'
}

Write-Host 'Installation de l''agent Komoku' -ForegroundColor Cyan

New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
Copy-Item $SourceAgent $AgentPath -Force
Write-Host "  agent      $AgentPath"

$config = [ordered]@{
    serverUrl        = $ServerUrl.TrimEnd('/')
    apiKey           = $ApiKey
    label            = $Label
    collectPublicIp  = (-not $NoPublicIp)
    collectGpuLoad   = (-not $NoGpuLoad)
    collectSecurity  = $true
    timeoutSeconds   = 20
}
$config | ConvertTo-Json -Depth 3 | Set-Content $ConfigPath -Encoding UTF8
Write-Host "  config     $ConfigPath"

# La configuration porte la cle API : seuls SYSTEM et les administrateurs la lisent.
#
# Trois pieges, tous rencontres sur un poste francais joint a un domaine :
#
#   1. « NT AUTHORITY\SYSTEM » et « BUILTIN\Administrators » n'existent pas
#      sous ces noms sur un Windows francais (« AUTORITE NT\Systeme »,
#      « BUILTIN\Administrateurs »). On designe donc les comptes par leur SID,
#      identique dans toutes les langues.
#   2. Set-Acl reecrit le descripteur entier, proprietaire compris, et echoue
#      avec « la relation d'approbation a echoue » quand le poste ne joint pas
#      son controleur de domaine. icacls ne touche qu'aux droits.
#   3. icacls /inheritance:r RECOPIE les entrees heritees en explicites au lieu
#      de les supprimer : il faut ensuite retirer nommement celles qu'on ne
#      veut pas garder.
#
# GetAccessRules(SecurityIdentifier) lit les SID bruts, sans resolution de nom,
# donc sans aucun appel au domaine.

$SID_SYSTEM = 'S-1-5-18'
$SID_ADMINS = 'S-1-5-32-544'
$sidAutorises = @($SID_SYSTEM, $SID_ADMINS)
$droitsPoses = $false

$prefPrecedente = $ErrorActionPreference
# icacls ecrit sur la sortie d'erreur sans que ce soit un echec : sous
# ErrorActionPreference = Stop, PowerShell 5.1 en ferait une erreur bloquante.
$ErrorActionPreference = 'Continue'
try {
    # ORDRE CAPITAL : on ACCORDE avant de RETIRER.
    # L'inverse laisse une fenetre ou le fichier n'a plus aucune entree ; si
    # l'octroi echoue alors, plus personne n'y accede, pas meme SYSTEM, et
    # l'agent ne demarre plus. C'est exactement ce qui est arrive en test.
    & icacls $ConfigPath /grant "*${SID_SYSTEM}:(F)" "*${SID_ADMINS}:(F)" | Out-Null

    # Seulement maintenant : couper l'heritage, puis retirer les comptes
    # indesirables (typiquement BUILTIN\Utilisateurs, en lecture).
    & icacls $ConfigPath /inheritance:r | Out-Null
    foreach ($ace in (Get-Acl $ConfigPath).GetAccessRules(
            $true, $true, [Security.Principal.SecurityIdentifier])) {
        $sid = $ace.IdentityReference.Value
        if ($sid -notin $sidAutorises) { & icacls $ConfigPath /remove:g "*$sid" | Out-Null }
    }

    # Relecture : le code de sortie d'icacls vaut 0 meme quand rien n'a pris.
    # On exige les deux comptes PRESENTS et aucun autre : verifier seulement
    # l'absence d'intrus laisserait passer une liste vide, c'est-a-dire un
    # fichier que personne ne peut plus lire.
    $effectifs = @((Get-Acl $ConfigPath).GetAccessRules(
        $true, $true, [Security.Principal.SecurityIdentifier]))
    $sidsPresents = @($effectifs | ForEach-Object { $_.IdentityReference.Value } | Sort-Object -Unique)
    $manquants = @($sidAutorises | Where-Object { $_ -notin $sidsPresents })
    $intrus = @($sidsPresents | Where-Object { $_ -notin $sidAutorises })

    if ($manquants.Count -eq 0 -and $intrus.Count -eq 0) {
        $droitsPoses = $true
        Write-Host '  droits     SYSTEM + administrateurs uniquement'
    } else {
        # Filet de securite : on ne laisse jamais le fichier inaccessible.
        & icacls $ConfigPath /reset | Out-Null
        Write-Warning ('Restriction des droits incomplete, heritage restaure. ' +
            "Manquants : $($manquants -join ', ') ; en trop : $($intrus -join ', ')")
    }
} catch {
    & icacls $ConfigPath /reset | Out-Null
    Write-Warning "Restriction des droits impossible, heritage restaure : $($_.Exception.Message)"
} finally {
    $ErrorActionPreference = $prefPrecedente
}

if (-not $droitsPoses) {
    Write-Warning ("La cle API dans $ConfigPath reste lisible par les utilisateurs " +
        'de ce poste. Restreins les droits a la main (clic droit > Proprietes > Securite) ' +
        'avant de deployer sur un poste partage.')
}

# Tache planifiee : au demarrage, puis repetee indefiniment.
# Un demarrage differe de 2 min laisse le reseau s'etablir avant le premier envoi.
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$AgentPath`""

$triggerBoot = New-ScheduledTaskTrigger -AtStartup
$triggerBoot.Delay = 'PT2M'

$triggerRepeat = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)

$principal = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\SYSTEM' -RunLevel Highest

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
    -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 5)

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

Register-ScheduledTask -TaskName $TaskName `
    -Description 'Remonte l''etat de ce poste au tableau de bord Komoku.' `
    -Action $action -Trigger @($triggerBoot, $triggerRepeat) `
    -Principal $principal -Settings $settings | Out-Null

Write-Host "  tache      « $TaskName », toutes les $IntervalMinutes min, sous SYSTEM"

$log = Join-Path $InstallDir 'agent.log'

# On note la taille du journal AVANT de declencher : sans cela, une
# reinstallation afficherait les lignes de la veille comme si elles venaient
# d'etre ecrites, et conclurait au succes sur un envoi qui n'a pas eu lieu.
$lignesAvant = 0
if (Test-Path $log) { $lignesAvant = @(Get-Content $log -ErrorAction SilentlyContinue).Count }

Write-Host ''
Write-Host 'Premier envoi de test...' -ForegroundColor Cyan
Start-ScheduledTask -TaskName $TaskName

# L'agent met 4 a 12 s selon le poste, davantage au tout premier passage
# puisqu'il doit constituer son inventaire. On attend le resultat plutot
# qu'une duree fixe.
$nouvelles = @()
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 2
    if (-not (Test-Path $log)) { continue }
    $toutes = @(Get-Content $log -ErrorAction SilentlyContinue)
    $nouvelles = @($toutes | Select-Object -Skip $lignesAvant)
    if ($nouvelles.Count -gt 0 -and ($nouvelles -match 'Envoi OK|ERROR')) { break }
}

foreach ($ligne in $nouvelles) { Write-Host "  $ligne" -ForegroundColor DarkGray }

Write-Host ''
if ($nouvelles -match 'Envoi OK') {
    Write-Host 'Installation terminee : le poste remonte bien au serveur.' -ForegroundColor Green
} else {
    Write-Host 'Installation terminee, mais aucun envoi confirme.' -ForegroundColor Yellow
    if ($nouvelles.Count -eq 0) {
        Write-Host '  Aucune nouvelle ligne de journal : la tache n''a peut-etre pas demarre.'
    }
    Write-Host "  Journal : $log"
    Write-Host "  Test manuel : powershell -ExecutionPolicy Bypass -File `"$AgentPath`" -Show"
}
