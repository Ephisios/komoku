<#
.SYNOPSIS
    Desinstalle l'agent Komoku de ce poste.

.PARAMETER KeepData
    Conserve C:\ProgramData\Komoku (journal, identifiant du poste, caches)
    au lieu de le supprimer.

.EXAMPLE
    .\uninstall.ps1
#>
[CmdletBinding()]
param([switch]$KeepData)

$ErrorActionPreference = 'Stop'

$TaskName = 'Komoku Agent'
$InstallDir = Join-Path $env:ProgramData 'Komoku'

$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($id)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Cette desinstallation requiert une invite PowerShell lancee en administrateur.'
}

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Tache planifiee « $TaskName » supprimee." -ForegroundColor Green
} else {
    Write-Host "Aucune tache « $TaskName » sur ce poste." -ForegroundColor DarkGray
}

if ($KeepData) {
    Write-Host "Donnees conservees dans $InstallDir."
} elseif (Test-Path $InstallDir) {
    Remove-Item $InstallDir -Recurse -Force
    Write-Host "$InstallDir supprime." -ForegroundColor Green
}

Write-Host ''
Write-Host 'Le poste reste visible dans le tableau de bord jusqu''a ce que tu le retires'
Write-Host 'depuis le detail du poste, bouton « Retirer du parc ».'
