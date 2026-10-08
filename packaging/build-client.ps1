<#
.SYNOPSIS
    Fabrique l'installateur client Komoku : un seul .exe a double-cliquer.

.DESCRIPTION
    Assemble l'agent, les scripts d'installation et les parametres de connexion
    (URL du serveur et cle API deja remplies), puis scelle le tout en un
    executable auto-extractible avec IExpress, fourni avec Windows.

    Produit deux fichiers :
      Installer-Komoku.exe     a donner aux collaborateurs
      Desinstaller-Komoku.exe  pour retirer l'agent d'un poste

    Le collaborateur double-clique, accepte l'elevation, et c'est fini : il n'a
    ni URL ni cle a saisir.

.PARAMETER ServerUrl
    URL de base du serveur, par exemple https://komoku.monentreprise.fr

.PARAMETER ApiKey
    Cle API du serveur. install-serveur.sh l'affiche a la fin, dans une ligne
    de commande prete a copier.

.PARAMETER Label
    Nom affiche dans le tableau de bord. Laisse vide pour utiliser le nom
    reseau du poste : c'est le bon choix pour un paquet distribue a plusieurs
    collaborateurs, qui porteraient sinon tous le meme nom.

.PARAMETER IntervalMinutes
    Frequence d'envoi, en minutes. 3 par defaut.

.PARAMETER OutDir
    Dossier de sortie. .\dist par defaut.

.PARAMETER NoExe
    S'arrete au dossier prepare, sans appeler IExpress. Utile pour inspecter le
    contenu, ou pour deployer par GPO plutot que par executable.

.EXAMPLE
    .\build-client.ps1 -ServerUrl https://komoku.exemple.fr -ApiKey "xxxx"
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ServerUrl,
    [Parameter(Mandatory = $true)][string]$ApiKey,
    [string]$Label = '',
    [int]$IntervalMinutes = 3,
    [string]$OutDir,
    [switch]$NoExe
)

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Definition)
$AgentDir = Join-Path $Root 'agent'
if (-not $OutDir) { $OutDir = Join-Path $Root 'dist' }

# --------------------------------------------------------------- controles

if ($ServerUrl -notmatch '^https?://[^\s/]+') {
    throw "ServerUrl doit commencer par http:// ou https:// (recu : $ServerUrl)"
}
if ($ServerUrl -match '^http://' -and $ServerUrl -notmatch '^http://(127\.0\.0\.1|localhost)') {
    Write-Warning ('Serveur en HTTP simple : la cle API et les rapports circuleront ' +
        'en clair sur le reseau. A reserver aux essais locaux.')
}
if ($ApiKey.Trim().Length -lt 8) {
    throw 'ApiKey semble trop courte. Utilise celle generee par le serveur.'
}
if ($IntervalMinutes -lt 1 -or $IntervalMinutes -gt 1440) {
    throw 'IntervalMinutes doit etre comprise entre 1 et 1440.'
}
if ($ApiKey -match '"') { throw 'ApiKey ne doit pas contenir de guillemet double.' }
if ($Label -match '"') { throw 'Label ne doit pas contenir de guillemet double.' }

foreach ($f in @('komoku-agent.ps1', 'install.ps1', 'uninstall.ps1')) {
    if (-not (Test-Path (Join-Path $AgentDir $f))) {
        throw "Fichier introuvable : $(Join-Path $AgentDir $f)"
    }
}

$iexpress = Join-Path $env:WINDIR 'System32\iexpress.exe'
if (-not $NoExe -and -not (Test-Path $iexpress)) {
    throw 'iexpress.exe est introuvable. Relance avec -NoExe pour produire un dossier.'
}

Write-Host 'Fabrication de l''installateur client Komoku' -ForegroundColor Cyan
Write-Host "  serveur    $ServerUrl"
Write-Host "  intervalle $IntervalMinutes min"
if ($Label) { Write-Host "  etiquette  $Label" }
else { Write-Host '  etiquette  (nom reseau du poste)' }

# ------------------------------------------------------- modele de lanceur

# Le .cmd n'est qu'une amorce : il sert uniquement a resoudre %~dp0, que
# IExpress ne fournit pas autrement. Toute la logique vit en PowerShell, ou la
# detection d'elevation est fiable.
$AMORCE = @'
@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0__SCRIPT__"
'@

$LANCEUR = @'
param([switch]$Relance)

$ErrorActionPreference = 'Stop'
$Ici = Split-Path -Parent $MyInvocation.MyCommand.Definition

# Transit dans le TEMP de l'utilisateur, et non dans ProgramData : ce dossier
# contient la cle API en clair le temps de l'installation. ProgramData accorde
# BUILTIN\Utilisateurs en lecture par heritage, ce qui exposait la cle a tous
# les comptes du poste et annulait le durcissement fait sur la configuration.
# Le TEMP utilisateur n'est accessible qu'a SYSTEM, aux administrateurs et a
# son proprietaire.
$Stage = Join-Path $env:TEMP '__STAGE__'

function Test-Admin {
    # Methode faisant autorite, la meme qu'install.ps1.
    #
    # On n'utilise surtout PAS "net session" : sur un poste joint a un
    # domaine, il renvoie un code de retour 0 alors que le processus n'est pas
    # eleve. C'est ce qui faisait echouer la premiere version de ce lanceur.
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($id)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Attendre-Fermeture {
    Write-Host ''
    try { [void](Read-Host 'Appuyez sur Entree pour fermer') } catch {}
}

function Nettoyer-Transit {
    # Le dossier de transit contient la cle API en clair : il ne doit pas
    # survivre a l'installation. Quelques essais, le temps que les verrous du
    # processus eleve retombent.
    if (-not (Test-Path $Stage)) { return }
    for ($i = 0; $i -lt 10; $i++) {
        try { Remove-Item -LiteralPath $Stage -Recurse -Force -ErrorAction Stop; return }
        catch { Start-Sleep -Milliseconds 700 }
    }
    Write-Host ''
    Write-Host "Attention : $Stage n'a pas pu etre efface." -ForegroundColor Yellow
    Write-Host 'Supprimez ce dossier a la main : il contient la cle du serveur.' -ForegroundColor Yellow
}

if (-not (Test-Admin)) {
    if ($Relance) {
        # Deja passe par l'elevation et toujours pas administrateur : on
        # s'arrete au lieu de relancer indefiniment.
        Write-Host ''
        Write-Host 'Les droits administrateur n''ont pas pu etre obtenus.' -ForegroundColor Red
        Write-Host "Compte en cours : $([Security.Principal.WindowsIdentity]::GetCurrent().Name)"
        Write-Host ''
        Write-Host 'Faites un clic droit sur l''executable, puis'
        Write-Host '"Executer en tant qu''administrateur".'
        Attendre-Fermeture
        exit 1
    }

    # Recopie dans un dossier stable AVANT d'elever : IExpress efface son
    # dossier temporaire des que ce processus rend la main, et le processus
    # eleve travaillerait alors sur des fichiers deja disparus.
    try {
        if (Test-Path $Stage) { Remove-Item $Stage -Recurse -Force }
        New-Item -ItemType Directory -Path $Stage -Force | Out-Null
        Copy-Item (Join-Path $Ici '*') $Stage -Force
    } catch {
        Write-Host "Preparation impossible : $($_.Exception.Message)" -ForegroundColor Red
        Attendre-Fermeture
        exit 1
    }

    # -Wait : on attend la fin du processus eleve pour pouvoir effacer le
    # dossier de transit juste apres.
    #
    # C'est le parent qui fait le menage, pas l'enfant : l'enfant s'execute
    # DEPUIS ce dossier, PowerShell y garde son propre script ouvert, et sa
    # tentative de suppression echouait en silence en y laissant la cle API.
    try {
        Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -ErrorAction Stop -ArgumentList @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass',
            '-File', (Join-Path $Stage '__SCRIPT__'),
            '-Relance'
        )
    } catch {
        Write-Host ''
        Write-Host 'L''elevation a ete refusee.' -ForegroundColor Yellow
        Write-Host 'Cette operation necessite les droits administrateur.'
        Nettoyer-Transit
        Attendre-Fermeture
        exit 1
    }

    Nettoyer-Transit
    exit 0
}

# ------------------------------------------------------ ici : administrateur

$code = 1
try {
    Write-Host ''
    & powershell.exe -NoProfile -ExecutionPolicy Bypass `
        -File (Join-Path $Ici '__CIBLE__') __ARGS__
    $code = $LASTEXITCODE
    if ($null -eq $code) { $code = 0 }
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    $code = 1
}

Write-Host ''
if ($code -eq 0) {
    Write-Host '========================================================' -ForegroundColor Green
    Write-Host '   __TITRE__' -ForegroundColor Green
    Write-Host '   Vous pouvez fermer cette fenetre.' -ForegroundColor Green
    Write-Host '========================================================' -ForegroundColor Green
} else {
    Write-Host '========================================================' -ForegroundColor Red
    Write-Host "   Echec (code $code)." -ForegroundColor Red
    Write-Host '   Faites une photo de cette fenetre et transmettez-la.' -ForegroundColor Red
    Write-Host '========================================================' -ForegroundColor Red
}

# Pas de menage ici : c'est le processus parent, qui attend la fin de
# celui-ci, qui efface le dossier de transit. Lui n'y tourne pas, donc rien
# n'y est verrouille.
Attendre-Fermeture
exit $code
'@

# ------------------------------------------------------------- preparation

$Stage = Join-Path ([IO.Path]::GetTempPath()) ('komoku-build-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $Stage -Force | Out-Null

try {
    foreach ($f in @('komoku-agent.ps1', 'install.ps1', 'uninstall.ps1')) {
        Copy-Item (Join-Path $AgentDir $f) (Join-Path $Stage $f) -Force
    }

    # Les valeurs sont injectees ici, et nulle part ailleurs : un seul endroit
    # a verifier si l'URL ou la cle changent.
    $argsInstall = "-ServerUrl `"$ServerUrl`" -ApiKey `"$ApiKey`" -IntervalMinutes $IntervalMinutes"
    if ($Label) { $argsInstall += " -Label `"$Label`"" }

    # String.Replace et non -replace : le texte injecte contient des $ et des \
    # que le moteur d'expressions regulieres interpreterait.
    $lanceurInstall = $LANCEUR.
        Replace('__STAGE__', 'Komoku-setup').
        Replace('__SCRIPT__', 'Lanceur-install.ps1').
        Replace('__CIBLE__', 'install.ps1').
        Replace('__ARGS__', $argsInstall).
        Replace('__TITRE__', 'Installation reussie. Ce poste est maintenant suivi.')

    $lanceurDesinstall = $LANCEUR.
        Replace('__STAGE__', 'Komoku-setup-u').
        Replace('__SCRIPT__', 'Lanceur-desinstall.ps1').
        Replace('__CIBLE__', 'uninstall.ps1').
        Replace('__ARGS__', '').
        Replace('__TITRE__', 'Agent retire de ce poste.')

    # Deux encodages, pour deux lecteurs differents :
    #
    #  - les .ps1 avec BOM UTF-8. PowerShell 5.1 lit un script SANS BOM en
    #    page de code ANSI : les accents et les guillemets francais y
    #    ressortaient en charabia.
    #  - les .cmd sans BOM. cmd.exe lit en page de code OEM et un BOM ferait
    #    echouer la toute premiere ligne du fichier.
    $utf8AvecBom = New-Object Text.UTF8Encoding($true)
    $utf8SansBom = New-Object Text.UTF8Encoding($false)
    [IO.File]::WriteAllText((Join-Path $Stage 'Lanceur-install.ps1'), $lanceurInstall, $utf8AvecBom)
    [IO.File]::WriteAllText((Join-Path $Stage 'Lanceur-desinstall.ps1'), $lanceurDesinstall, $utf8AvecBom)
    [IO.File]::WriteAllText((Join-Path $Stage 'Installer.cmd'),
        $AMORCE.Replace('__SCRIPT__', 'Lanceur-install.ps1'), $utf8SansBom)
    [IO.File]::WriteAllText((Join-Path $Stage 'Desinstaller.cmd'),
        $AMORCE.Replace('__SCRIPT__', 'Lanceur-desinstall.ps1'), $utf8SansBom)

    New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

    if ($NoExe) {
        $dossier = Join-Path $OutDir 'komoku-client'
        if (Test-Path $dossier) { Remove-Item $dossier -Recurse -Force }
        Copy-Item $Stage $dossier -Recurse -Force
        Write-Host ''
        Write-Host "Dossier pret : $dossier" -ForegroundColor Green
        Write-Host '  Lancer Installer.cmd sur le poste a suivre.'
        return
    }

    # ------------------------------------------------------------- IExpress

    function New-Sed {
        param([string]$Nom, [string]$Lanceur, [string]$Titre, [string]$Cible, [string[]]$Fichiers)

        $lignesFichiers = @()
        for ($i = 0; $i -lt $Fichiers.Count; $i++) {
            $lignesFichiers += "FILE$i=`"$($Fichiers[$i])`""
        }
        $lignesSource = $Fichiers | ForEach-Object { "$_=" }

        $sed = @"
[Version]
Class=IEXPRESS
SEDVersion=3
[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=0
HideExtractAnimation=1
UseLongFileName=1
InsideCompressed=0
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=%InstallPrompt%
DisplayLicense=%DisplayLicense%
FinishMessage=%FinishMessage%
TargetName=%TargetName%
FriendlyName=%FriendlyName%
AppLaunched=%AppLaunched%
PostInstallCmd=%PostInstallCmd%
AdminQuietInstCmd=%AdminQuietInstCmd%
UserQuietInstCmd=%UserQuietInstCmd%
SourceFiles=SourceFiles
[Strings]
InstallPrompt=
DisplayLicense=
FinishMessage=
TargetName=$Cible
FriendlyName=$Titre
AppLaunched=cmd.exe /c $Lanceur
PostInstallCmd=<None>
AdminQuietInstCmd=
UserQuietInstCmd=
$($lignesFichiers -join "`r`n")
[SourceFiles]
SourceFiles0=$Stage
[SourceFiles0]
$($lignesSource -join "`r`n")
"@
        $chemin = Join-Path $Stage "$Nom.sed"
        # IExpress lit le .sed en ANSI, pas en UTF-8.
        [IO.File]::WriteAllText($chemin, $sed, [Text.Encoding]::Default)
        return $chemin
    }

    $cibleInstall = Join-Path $OutDir 'Installer-Komoku.exe'
    $cibleDesinstall = Join-Path $OutDir 'Desinstaller-Komoku.exe'
    foreach ($c in @($cibleInstall, $cibleDesinstall)) {
        if (Test-Path $c) { Remove-Item $c -Force }
    }

    $paquets = @(
        @{ nom = 'install'; lanceur = 'Installer.cmd'
           titre = 'Agent Komoku - installation'; cible = $cibleInstall
           fichiers = @('komoku-agent.ps1', 'install.ps1', 'Lanceur-install.ps1', 'Installer.cmd') },
        @{ nom = 'desinstall'; lanceur = 'Desinstaller.cmd'
           titre = 'Agent Komoku - desinstallation'; cible = $cibleDesinstall
           fichiers = @('uninstall.ps1', 'Lanceur-desinstall.ps1', 'Desinstaller.cmd') }
    )

    foreach ($p in $paquets) {
        $sed = New-Sed -Nom $p.nom -Lanceur $p.lanceur -Titre $p.titre -Cible $p.cible -Fichiers $p.fichiers
        & $iexpress /N /Q $sed | Out-Null
        if (-not (Test-Path $p.cible)) {
            throw "IExpress n'a pas produit $($p.cible). Relance sans /Q pour voir l'erreur : iexpress /N `"$sed`""
        }
    }

    Write-Host ''
    foreach ($c in @($cibleInstall, $cibleDesinstall)) {
        $ko = [math]::Round((Get-Item $c).Length / 1KB)
        Write-Host ('  {0}  ({1} Ko)' -f (Split-Path $c -Leaf), $ko) -ForegroundColor Green
    }
    Write-Host ''
    Write-Host "Dossier : $OutDir"
    Write-Host ''
    Write-Warning ('Ces executables ne sont pas signes : SmartScreen affichera un ' +
        'avertissement, et certains antivirus peuvent les bloquer. Pour un ' +
        'deploiement a l''echelle, signe-les ou distribue par GPO.')
    Write-Warning 'Installer-Komoku.exe contient la cle API en clair. Ne le publie pas.'
}
finally {
    if (Test-Path $Stage) { Remove-Item $Stage -Recurse -Force -ErrorAction SilentlyContinue }
}
