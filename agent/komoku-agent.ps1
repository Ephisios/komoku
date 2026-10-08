<#
.SYNOPSIS
    Agent Komoku - collecte l'etat d'un poste Windows et l'envoie au serveur.

.DESCRIPTION
    Compatible Windows PowerShell 5.1 (present par defaut sur Windows 10/11).
    Aucune dependance externe. Concu pour tourner en tache planifiee sous SYSTEM.

    Collecte a deux vitesses :
      - metriques live (CPU, RAM, disque, GPU, reseau, VPN) a chaque passage
      - inventaire (modele, securite, BitLocker, correctifs) mis en cache 60 min,
        parce que ces donnees sont lentes a lire et ne bougent pas d'une minute
        a l'autre.

.PARAMETER ConfigPath
    Chemin du fichier de configuration JSON.
    Par defaut : komoku.config.json a cote du script, sinon dans C:\ProgramData\Komoku.

.PARAMETER Show
    Affiche le rapport dans la console au lieu de l'envoyer au serveur.

.PARAMETER Refresh
    Force le rafraichissement de l'inventaire, sans attendre l'expiration du cache.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\komoku-agent.ps1 -Show
#>
[CmdletBinding()]
param(
    [string]$ConfigPath,
    [switch]$Show,
    [switch]$Refresh
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

# TLS 1.2 : indispensable pour POST en HTTPS depuis PowerShell 5.1
try {
    [Net.ServicePointManager]::SecurityProtocol = `
        [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls11
} catch {}

$AgentVersion = '1.1.0'
$InventoryTtlMinutes = 60
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$StateDir = Join-Path $env:ProgramData 'Komoku'
$LogFile = Join-Path $StateDir 'agent.log'

function Initialize-StateDir {
    if (-not (Test-Path $StateDir)) {
        New-Item -ItemType Directory -Path $StateDir -Force | Out-Null
    }
}

function Write-Log {
    param([string]$Message, [string]$Level = 'INFO')
    $line = '{0} [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
    if ($Show) { Write-Host $line -ForegroundColor DarkGray }

    # -ErrorAction Stop est indispensable : sans lui, Add-Content leve une
    # erreur NON bloquante, que catch n'intercepte pas. Elle s'afficherait
    # alors sur la sortie d'erreur de la tache planifiee, et la ligne serait
    # perdue sans qu'on retente.
    #
    # Un antivirus qui scanne ProgramData verrouille le fichier une fraction
    # de seconde : deux essais suffisent a absorber ces collisions.
    for ($i = 1; $i -le 2; $i++) {
        try {
            Initialize-StateDir
            # Rotation simple : on repart a zero au-dela de 1 Mo
            if ((Test-Path $LogFile) -and ((Get-Item $LogFile -ErrorAction Stop).Length -gt 1MB)) {
                Move-Item $LogFile "$LogFile.old" -Force -ErrorAction Stop
            }
            Add-Content -Path $LogFile -Value $line -Encoding UTF8 -ErrorAction Stop
            return
        } catch {
            if ($i -eq 2) { return }   # le journal n'est jamais une raison d'echouer
            Start-Sleep -Milliseconds 250
        }
    }
}

function Get-Config {
    $path = $ConfigPath
    if (-not $path) { $path = Join-Path $ScriptDir 'komoku.config.json' }
    if (-not (Test-Path $path)) { $path = Join-Path $StateDir 'komoku.config.json' }

    $cfg = [ordered]@{
        serverUrl        = $env:KOMOKU_SERVER_URL
        apiKey           = $env:KOMOKU_API_KEY
        label            = ''
        collectPublicIp  = $true
        collectGpuLoad   = $true
        collectProcesses = $true
        collectSecurity  = $true
        timeoutSeconds   = 20
    }

    if (Test-Path $path) {
        try {
            $raw = Get-Content $path -Raw -Encoding UTF8 | ConvertFrom-Json
            foreach ($k in @($cfg.Keys)) {
                if ($null -ne $raw.$k -and "$($raw.$k)" -ne '') { $cfg[$k] = $raw.$k }
            }
        } catch {
            Write-Log "Configuration illisible ($path) : $($_.Exception.Message)" 'WARN'
        }
    }
    return $cfg
}

function Get-MachineId {
    <# Identifiant stable du poste : survit a un renommage de la machine. #>
    $idFile = Join-Path $StateDir 'machine-id'
    if (Test-Path $idFile) {
        $existing = (Get-Content $idFile -Raw).Trim()
        if ($existing) { return $existing }
    }
    $seed = $null
    try {
        $uuid = (Get-CimInstance Win32_ComputerSystemProduct -ErrorAction Stop).UUID
        if ($uuid -and $uuid -notmatch '^0{8}-|FFFFFFFF') { $seed = $uuid }
    } catch {}
    if (-not $seed) { $seed = [guid]::NewGuid().ToString() }

    $sha = [Security.Cryptography.SHA256]::Create()
    $bytes = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($seed))
    $id = -join ($bytes[0..7] | ForEach-Object { $_.ToString('x2') })

    try {
        Initialize-StateDir
        Set-Content -Path $idFile -Value $id -Encoding ASCII
    } catch {}
    return $id
}

# ============================================================ metriques live

function Get-LiveSystemInfo {
    $out = [ordered]@{}
    try {
        $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
        $out.lastBoot = $os.LastBootUpTime.ToUniversalTime().ToString('o')
        $out.uptimeSeconds = [int]((Get-Date) - $os.LastBootUpTime).TotalSeconds

        $totalKb = [double]$os.TotalVisibleMemorySize
        $freeKb = [double]$os.FreePhysicalMemory
        $mem = [ordered]@{
            totalBytes = [long]($totalKb * 1024)
            freeBytes  = [long]($freeKb * 1024)
            usedBytes  = [long](($totalKb - $freeKb) * 1024)
        }
        if ($totalKb -gt 0) {
            $mem.usedPercent = [math]::Round((($totalKb - $freeKb) / $totalKb) * 100, 1)
        }
        if ($os.TotalVirtualMemorySize -gt 0) {
            $mem.swapUsedPercent = [math]::Round(
                (($os.TotalVirtualMemorySize - $os.FreeVirtualMemory) / $os.TotalVirtualMemorySize) * 100, 1)
        }
        $out.memory = $mem
    } catch {}

    try {
        $cs = Get-CimInstance Win32_ComputerSystem -ErrorAction Stop
        $out.loggedUser = $cs.UserName
    } catch {}
    return $out
}

function Get-CpuLoad {
    # Win32_PerfFormattedData est insensible a la langue de Windows,
    # contrairement a Get-Counter dont les chemins sont traduits.
    try {
        $perf = Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor `
            -Filter "Name='_Total'" -ErrorAction Stop
        return [math]::Round([double]$perf.PercentProcessorTime, 1)
    } catch {}
    try {
        $samples = @(Get-CimInstance Win32_Processor -ErrorAction Stop | Select-Object -Expand LoadPercentage)
        return [math]::Round(($samples | Measure-Object -Average).Average, 1)
    } catch {}
    return $null
}

function Get-GpuCounterPaths {
    <#
      Les chemins de compteurs sont traduits selon la langue de Windows.
      On les decouvre une seule fois (Get-Counter -ListSet * coute 1 a 3 s) et on
      met en cache un chemin a joker, pas les instances : celles-ci changent a
      chaque demarrage de processus.
    #>
    $cacheFile = Join-Path $StateDir 'gpu-counters.json'
    $stamp = [Environment]::OSVersion.Version.ToString()

    if (Test-Path $cacheFile) {
        try {
            $cached = Get-Content $cacheFile -Raw | ConvertFrom-Json
            if ($cached.stamp -eq $stamp) {
                return @{ util = $cached.util; vram = $cached.vram }
            }
        } catch {}
    }

    $util = $null
    $vram = $null

    # Chemin anglais d'abord : valable sur la majorite des postes, y compris
    # beaucoup de Windows francais ou les compteurs restent en anglais.
    $tryUtil = '\GPU Engine(*engtype_3D)\Utilization Percentage'
    try {
        Get-Counter -Counter $tryUtil -ErrorAction Stop | Out-Null
        $util = $tryUtil
        $tryVram = '\GPU Process Memory(*)\Dedicated Usage'
        try {
            Get-Counter -Counter $tryVram -ErrorAction Stop | Out-Null
            $vram = $tryVram
        } catch {}
    } catch {
        # Sinon on cherche les jeux de compteurs dont le nom contient "GPU"
        try {
            $sets = @(Get-Counter -ListSet * -ErrorAction Stop | Where-Object { $_.CounterSetName -match 'GPU' })
            foreach ($s in $sets) {
                $p = @($s.PathsWithInstances | Where-Object {
                    $_ -match 'engtype_3D' -and $_ -notmatch '(?i)time|temps'
                })[0]
                if ($p -and -not $util) { $util = $p -replace '\([^)]*\)', '(*engtype_3D)' }

                $v = @($s.PathsWithInstances | Where-Object {
                    $_ -match '(?i)dedicated|dedie|dedi' -and $_ -match '(?i)usage|utilis'
                })[0]
                if ($v -and -not $vram) { $vram = $v -replace '\([^)]*\)', '(*)' }
            }
        } catch {}
    }

    try {
        Initialize-StateDir
        @{ stamp = $stamp; util = $util; vram = $vram } |
            ConvertTo-Json -Depth 3 | Set-Content $cacheFile -Encoding UTF8
    } catch {}

    return @{ util = $util; vram = $vram }
}

function Get-GpuLoad {
    $out = [ordered]@{ loadPercent = $null; vramUsedBytes = $null }

    # Voie rapide : les compteurs GPU exposes en classes WMI. 0,3 s contre 5,6 s
    # pour les memes compteurs via Get-Counter, qui doit enumerer une instance
    # PDH par processus. Les noms de classes WMI ne sont jamais traduits.
    try {
        $eng = @(Get-CimInstance -Query ("SELECT Name,UtilizationPercentage FROM " +
            "Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine " +
            "WHERE Name LIKE '%engtype_3D'") -ErrorAction Stop)
        if ($eng.Count -gt 0) {
            $sum = ($eng | Measure-Object -Property UtilizationPercentage -Sum).Sum
            $out.loadPercent = [math]::Round([math]::Min([double]$sum, 100), 1)
        }
        $mem = @(Get-CimInstance -ClassName Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory `
            -ErrorAction SilentlyContinue)
        if ($mem.Count -gt 0) {
            $used = ($mem | Measure-Object -Property DedicatedUsage -Sum).Sum
            if ($used -gt 0) { $out.vramUsedBytes = [long]$used }
        }
        if ($null -ne $out.loadPercent) { return $out }
    } catch {}

    # Repli PDH pour les Windows ou ces classes n'existent pas
    $paths = Get-GpuCounterPaths

    if ($paths.util) {
        try {
            $samples = (Get-Counter -Counter $paths.util -ErrorAction SilentlyContinue).CounterSamples
            if ($samples) {
                $sum = ($samples | Measure-Object -Property CookedValue -Sum).Sum
                $out.loadPercent = [math]::Round([math]::Min([double]$sum, 100), 1)
            }
        } catch {}
    }
    if ($paths.vram) {
        try {
            $samples = (Get-Counter -Counter $paths.vram -ErrorAction SilentlyContinue).CounterSamples
            if ($samples) {
                $sum = ($samples | Measure-Object -Property CookedValue -Sum).Sum
                if ($sum -gt 0) { $out.vramUsedBytes = [long]$sum }
            }
        } catch {}
    }
    return $out
}

function Get-DiskUsage {
    $disks = @()
    try {
        foreach ($d in @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' -ErrorAction Stop)) {
            if (-not $d.Size -or $d.Size -eq 0) { continue }
            $used = [long]($d.Size - $d.FreeSpace)
            $disks += [ordered]@{
                drive       = $d.DeviceID
                label       = $d.VolumeName
                fileSystem  = $d.FileSystem
                totalBytes  = [long]$d.Size
                freeBytes   = [long]$d.FreeSpace
                usedBytes   = $used
                usedPercent = [math]::Round(($used / [double]$d.Size) * 100, 1)
            }
        }
    } catch {}
    return $disks
}

function Get-NetworkInfo {
    param([bool]$WithPublicIp = $true, [int]$TimeoutSeconds = 20)

    $out = [ordered]@{ interfaces = @(); publicIp = $null; wifiSsid = $null; gateway = $null }

    # Une seule requete WMI pour IP + passerelle + DNS : 8x plus rapide que
    # Get-NetIPAddress + Get-NetRoute + Get-DnsClientServerAddress reunis.
    $adapters = @{}
    try {
        foreach ($a in @(Get-NetAdapter -ErrorAction Stop)) {
            $adapters[[int]$a.ifIndex] = $a
        }
    } catch {}

    try {
        foreach ($c in @(Get-CimInstance Win32_NetworkAdapterConfiguration `
                -Filter 'IPEnabled=True' -ErrorAction Stop)) {

            $ipv4 = @($c.IPAddress | Where-Object { $_ -match '^\d{1,3}(\.\d{1,3}){3}$' })
            if ($ipv4.Count -eq 0) { continue }

            $idx = [int]$c.InterfaceIndex
            $alias = $c.Description
            $status = $null
            $linkSpeed = $null
            if ($adapters.ContainsKey($idx)) {
                $alias = $adapters[$idx].Name
                $status = "$($adapters[$idx].Status)"
                $linkSpeed = "$($adapters[$idx].LinkSpeed)"
            }

            $gw = @($c.DefaultIPGateway | Where-Object { $_ -match '^\d{1,3}(\.\d{1,3}){3}$' })
            $out.interfaces += [ordered]@{
                alias       = $alias
                description = $c.Description
                ipv4        = $ipv4
                gateway     = $gw
                dns         = @($c.DNSServerSearchOrder | Where-Object { $_ })
                dhcp        = [bool]$c.DHCPEnabled
                mac         = $c.MACAddress
                linkSpeed   = $linkSpeed
                status      = $status
            }
            if (-not $out.gateway -and $gw.Count -gt 0) { $out.gateway = $gw[0] }
        }
    } catch {}

    # SSID Wi-Fi : netsh reste le seul moyen fiable sous PowerShell 5.1
    try {
        $netsh = & netsh wlan show interfaces 2>$null
        if ($netsh) {
            $line = $netsh | Where-Object { $_ -match '^\s*(SSID|Nom du SSID)\s*:' } | Select-Object -First 1
            if ($line) {
                $ssid = ($line -split ':', 2)[1].Trim()
                if ($ssid) { $out.wifiSsid = $ssid }
            }
        }
    } catch {}

    if ($WithPublicIp) {
        try {
            $r = Invoke-RestMethod -Uri 'https://api.ipify.org?format=json' `
                -TimeoutSec ([math]::Min($TimeoutSeconds, 8)) -ErrorAction Stop
            $out.publicIp = $r.ip
        } catch {
            Write-Log "IP publique indisponible : $($_.Exception.Message)" 'DEBUG'
        }
    }
    return $out
}

$script:VpnVendors = @(
    @{ pattern = 'wireguard|wintun';               name = 'WireGuard' }
    @{ pattern = 'openvpn|tap-windows|tap0901';    name = 'OpenVPN' }
    @{ pattern = 'nordlynx|nordvpn|nord vpn';      name = 'NordVPN' }
    @{ pattern = 'proton';                         name = 'Proton VPN' }
    @{ pattern = 'anyconnect|cisco secure client'; name = 'Cisco AnyConnect' }
    @{ pattern = 'fortinet|forticlient|fortissl';  name = 'FortiClient' }
    @{ pattern = 'globalprotect|palo alto';        name = 'GlobalProtect' }
    @{ pattern = 'tailscale';                      name = 'Tailscale' }
    @{ pattern = 'zerotier';                       name = 'ZeroTier' }
    @{ pattern = 'sonicwall|netextender';          name = 'SonicWall' }
    @{ pattern = 'check ?point';                   name = 'Check Point' }
    @{ pattern = 'pulse secure|juniper';           name = 'Pulse Secure' }
    @{ pattern = 'sophos';                         name = 'Sophos' }
    @{ pattern = 'mullvad';                        name = 'Mullvad' }
    @{ pattern = 'surfshark';                      name = 'Surfshark' }
    @{ pattern = 'expressvpn';                     name = 'ExpressVPN' }
    @{ pattern = 'cloudflare ?warp';               name = 'Cloudflare WARP' }
    @{ pattern = 'twingate';                       name = 'Twingate' }
    @{ pattern = 'zscaler';                        name = 'Zscaler' }
    @{ pattern = 'hamachi';                        name = 'Hamachi' }
)

function Get-VpnInfo {
    <#
      Trois signaux independants, parce qu'aucun ne couvre tous les cas :
        1. les connexions VPN natives Windows (IKEv2, L2TP, SSTP) via rasdial
        2. les cartes virtuelles des clients tiers, porteuses d'une vraie IP
        3. les processus de ces clients : installe mais pas connecte
    #>
    param($Interfaces = @())

    $out = [ordered]@{ connected = $false; name = $null; kind = $null; details = @() }

    # 1. VPN natif Windows : rasdial coute 0,3 s la ou Get-VpnConnection en coute 1,4
    try {
        $lines = @(& rasdial 2>$null)
        foreach ($l in $lines) {
            $t = "$l".Trim()
            if (-not $t) { continue }
            # on ecarte les deux lignes de service, dans les deux langues
            if ($t -match '(?i)^(aucune connexion|no connections)') { continue }
            if ($t -match "(?i)(command|commande).*(completed|ex.cut)") { continue }
            $out.details += [ordered]@{ source = 'windows'; name = $t; status = 'Connected'; server = $null }
            if (-not $out.connected) {
                $out.connected = $true; $out.name = $t; $out.kind = 'windows'
            }
        }
    } catch {}

    # 2. Cartes virtuelles portant une IP routable (pas une APIPA 169.254.x)
    foreach ($i in @($Interfaces)) {
        $real = @($i.ipv4 | Where-Object { $_ -notmatch '^169\.254\.' })
        if ($real.Count -eq 0) { continue }
        $haystack = "$($i.alias) $($i.description)".ToLower()
        foreach ($v in $script:VpnVendors) {
            if ($haystack -match $v.pattern) {
                $out.details += [ordered]@{
                    source = 'adapter'; name = $v.name
                    status = 'Up'; server = $i.description; ip = $real[0]
                }
                if (-not $out.connected) {
                    $out.connected = $true; $out.name = $v.name; $out.kind = 'adapter'
                }
                break
            }
        }
    }

    # 3. Client installe et lance, mais pas de tunnel actif : utile a savoir
    try {
        $running = (@(Get-Process -ErrorAction SilentlyContinue | Select-Object -Expand Name) -join ' ').ToLower()
        foreach ($v in $script:VpnVendors) {
            if ($running -match $v.pattern) {
                $already = @($out.details | Where-Object { $_.name -eq $v.name }).Count -gt 0
                if (-not $already) {
                    $out.details += [ordered]@{
                        source = 'process'; name = $v.name; status = 'Running'; server = $null
                    }
                }
            }
        }
    } catch {}

    return $out
}

function Get-BatteryInfo {
    try {
        $b = Get-CimInstance Win32_Battery -ErrorAction Stop | Select-Object -First 1
        if (-not $b) { return $null }
        return [ordered]@{
            percent   = [int]$b.EstimatedChargeRemaining
            onAc      = ($b.BatteryStatus -eq 2)   # 2 = sur secteur, 1 = sur batterie
            statusRaw = [int]$b.BatteryStatus
        }
    } catch { return $null }
}

function Get-RebootPending {
    try {
        $keys = @(
            'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending',
            'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired'
        )
        foreach ($k in $keys) { if (Test-Path $k) { return $true } }
        $pfro = Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager' `
            -Name PendingFileRenameOperations -ErrorAction SilentlyContinue
        if ($pfro -and $pfro.PendingFileRenameOperations) { return $true }
        return $false
    } catch { return $null }
}

function Get-TopProcesses {
    param([int]$Count = 6)
    try {
        $procs = Get-Process -ErrorAction SilentlyContinue |
            Where-Object { $_.WorkingSet64 -gt 0 } |
            Sort-Object WorkingSet64 -Descending |
            Select-Object -First $Count
        $out = @()
        foreach ($p in $procs) {
            $cpuTime = $null
            if ($p.CPU) { $cpuTime = [math]::Round($p.CPU, 1) }
            $out += [ordered]@{
                name     = $p.ProcessName
                ramBytes = [long]$p.WorkingSet64
                cpuTime  = $cpuTime
            }
        }
        return $out
    } catch { return @() }
}

# ============================================== inventaire (cache 60 minutes)

function Get-InventorySystem {
    $out = [ordered]@{}
    try {
        $cs = Get-CimInstance Win32_ComputerSystem -ErrorAction Stop
        $out.manufacturer = $cs.Manufacturer
        $out.model = $cs.Model
        $out.domain = $cs.Domain
    } catch {}
    try {
        $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
        $out.osName = ($os.Caption -replace '\s+', ' ').Trim()
        $out.osVersion = $os.Version
        $out.osBuild = $os.BuildNumber
        $out.osArch = $os.OSArchitecture
        $out.installedOn = $os.InstallDate.ToUniversalTime().ToString('o')
    } catch {}
    try { $out.serial = (Get-CimInstance Win32_BIOS -ErrorAction Stop).SerialNumber } catch {}
    try {
        $out.osDisplayVersion = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' `
            -Name DisplayVersion -ErrorAction Stop).DisplayVersion
    } catch {}
    try {
        $chassis = (Get-CimInstance Win32_SystemEnclosure -ErrorAction Stop).ChassisTypes
        $laptopCodes = @(8, 9, 10, 11, 12, 14, 18, 21, 30, 31, 32)
        $out.isLaptop = [bool](@($chassis | Where-Object { $laptopCodes -contains $_ }).Count)
    } catch {}
    return $out
}

function Get-InventoryCpu {
    $out = [ordered]@{}
    try {
        $cpu = @(Get-CimInstance Win32_Processor -ErrorAction Stop)[0]
        $out.name = ($cpu.Name -replace '\s+', ' ').Trim()
        $out.cores = $cpu.NumberOfCores
        $out.threads = $cpu.NumberOfLogicalProcessors
        $out.maxClockMhz = $cpu.MaxClockSpeed
    } catch {}
    return $out
}

function Get-InventoryGpu {
    $gpus = @()
    try {
        foreach ($g in @(Get-CimInstance Win32_VideoController -ErrorAction Stop)) {
            $vram = $null
            if ($g.AdapterRAM -and $g.AdapterRAM -gt 0) { $vram = [long]$g.AdapterRAM }
            $res = $null
            if ($g.CurrentHorizontalResolution) {
                $res = '{0}x{1}' -f $g.CurrentHorizontalResolution, $g.CurrentVerticalResolution
            }
            $gpus += [ordered]@{
                name          = ($g.Name -replace '\s+', ' ').Trim()
                driverVersion = $g.DriverVersion
                vramBytes     = $vram
                resolution    = $res
            }
        }
    } catch {}

    # AdapterRAM est un champ 32 bits, plafonne a 4 Go : la vraie taille est dans
    # le registre. On apparie par nom de pilote, pas par position.
    try {
        $regBase = 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}'
        foreach ($key in @(Get-ChildItem $regBase -ErrorAction Stop |
                Where-Object { $_.PSChildName -match '^\d{4}$' })) {
            $props = Get-ItemProperty $key.PSPath -ErrorAction SilentlyContinue
            if (-not $props) { continue }
            $size = $props.'HardwareInformation.qwMemorySize'
            $desc = $props.DriverDesc
            if (-not $size -or $size -le 0 -or -not $desc) { continue }
            foreach ($g in $gpus) {
                if ($g.name -eq $desc) { $g.vramBytes = [long]$size }
            }
        }
    } catch {}
    return $gpus
}

function Get-InventoryPhysicalDisks {
    $physical = @()
    try {
        foreach ($p in @(Get-PhysicalDisk -ErrorAction Stop)) {
            $physical += [ordered]@{
                name         = $p.FriendlyName
                mediaType    = "$($p.MediaType)"
                healthStatus = "$($p.HealthStatus)"
                sizeBytes    = [long]$p.Size
            }
        }
    } catch {}
    return $physical
}

function Get-InventorySecurity {
    $out = [ordered]@{}

    # Antivirus declare au centre de securite : couvre Defender et les tiers
    try {
        $av = @()
        foreach ($p in @(Get-CimInstance -Namespace 'root/SecurityCenter2' `
                -ClassName AntiVirusProduct -ErrorAction Stop)) {
            # productState encode 3 octets : [fournisseur][temps reel][signatures]
            $state = [int]$p.productState
            $hex = '{0:x6}' -f $state
            $rtByte = [Convert]::ToInt32($hex.Substring(2, 2), 16)
            $defByte = [Convert]::ToInt32($hex.Substring(4, 2), 16)
            $av += [ordered]@{
                name     = $p.displayName
                realTime = ($rtByte -eq 0x10 -or $rtByte -eq 0x11)
                upToDate = ($defByte -eq 0x00)
                stateRaw = $state
            }
        }
        $out.antivirus = $av
    } catch {}

    try {
        $mp = Get-MpComputerStatus -ErrorAction Stop
        $out.defender = [ordered]@{
            antivirusEnabled     = [bool]$mp.AntivirusEnabled
            realTimeProtection   = [bool]$mp.RealTimeProtectionEnabled
            signatureAgeDays     = [int]$mp.AntivirusSignatureAge
            lastQuickScanAgeDays = [int]$mp.QuickScanAge
            tamperProtection     = [bool]$mp.IsTamperProtected
        }
    } catch {}

    # Pare-feu via le registre : 0,1 s au lieu de 2,5 s pour Get-NetFirewallProfile
    try {
        $map = @{ Domain = 'Domain'; Standard = 'Private'; Public = 'Public' }
        $profiles = @()
        foreach ($k in $map.Keys) {
            $path = "HKLM:\SYSTEM\CurrentControlSet\Services\SharedAccess\Parameters\FirewallPolicy\${k}Profile"
            $v = Get-ItemProperty $path -Name EnableFirewall -ErrorAction SilentlyContinue
            # Absence de la valeur = active par defaut sous Windows
            $enabled = $true
            if ($v -and $null -ne $v.EnableFirewall) { $enabled = ([int]$v.EnableFirewall -eq 1) }
            $profiles += [ordered]@{ name = $map[$k]; enabled = $enabled }
        }
        $out.firewall = $profiles
    } catch {}

    try {
        $bl = @()
        foreach ($v in @(Get-BitLockerVolume -ErrorAction Stop)) {
            $bl += [ordered]@{
                mount      = $v.MountPoint
                protection = "$($v.ProtectionStatus)"
                percent    = [int]$v.EncryptionPercentage
            }
        }
        $out.bitlocker = $bl
    } catch {}

    try {
        $hotfix = Get-CimInstance Win32_QuickFixEngineering -ErrorAction Stop |
            Where-Object { $_.InstalledOn } |
            Sort-Object InstalledOn -Descending | Select-Object -First 1
        if ($hotfix) {
            $out.lastUpdate = [ordered]@{
                id   = $hotfix.HotFixID
                date = $hotfix.InstalledOn.ToUniversalTime().ToString('o')
            }
        }
    } catch {}

    # Profils VPN configures (connectes ou non) : complete rasdial
    try {
        $profiles = @()
        $conns = @()
        $conns += @(Get-VpnConnection -ErrorAction SilentlyContinue)
        $conns += @(Get-VpnConnection -AllUserConnection -ErrorAction SilentlyContinue)
        foreach ($c in $conns) {
            $profiles += [ordered]@{ name = $c.Name; server = $c.ServerAddress; type = "$($c.TunnelType)" }
        }
        $out.vpnProfiles = $profiles
    } catch {}

    return $out
}

function ConvertTo-Ordered {
    <#
      L'inventaire arrive soit frais (OrderedDictionary), soit relu du cache
      (PSCustomObject apres ConvertFrom-Json). Cette fonction aplanit les deux
      vers une table ordonnee qu'on peut completer avec les valeurs live.
    #>
    param($Source)
    $h = [ordered]@{}
    if ($null -eq $Source) { return $h }
    if ($Source -is [System.Collections.IDictionary]) {
        foreach ($k in $Source.Keys) { $h[$k] = $Source[$k] }
    } else {
        foreach ($p in $Source.PSObject.Properties) { $h[$p.Name] = $p.Value }
    }
    return $h
}

function Get-Inventory {
    param([bool]$WithSecurity = $true, [bool]$Force = $false)

    $cacheFile = Join-Path $StateDir 'inventory.json'
    if (-not $Force -and (Test-Path $cacheFile)) {
        try {
            $cached = Get-Content $cacheFile -Raw -Encoding UTF8 | ConvertFrom-Json
            $age = (Get-Date).ToUniversalTime() - [datetime]::Parse($cached.ts).ToUniversalTime()
            if ($age.TotalMinutes -lt $InventoryTtlMinutes -and $cached.data) {
                return @{ data = $cached.data; fromCache = $true }
            }
        } catch {}
    }

    $inv = [ordered]@{
        system        = Get-InventorySystem
        cpu           = Get-InventoryCpu
        gpuAdapters   = @(Get-InventoryGpu)
        physicalDisks = @(Get-InventoryPhysicalDisks)
    }
    if ($WithSecurity) { $inv.security = Get-InventorySecurity }

    try {
        Initialize-StateDir
        @{ ts = (Get-Date).ToUniversalTime().ToString('o'); data = $inv } |
            ConvertTo-Json -Depth 8 | Set-Content $cacheFile -Encoding UTF8
    } catch {}

    return @{ data = $inv; fromCache = $false }
}

# ================================================================== collecte

Initialize-StateDir
$cfg = Get-Config
$started = Get-Date

$inventory = Get-Inventory -WithSecurity ([bool]$cfg.collectSecurity) -Force ([bool]$Refresh)
$live = Get-LiveSystemInfo
$network = Get-NetworkInfo -WithPublicIp ([bool]$cfg.collectPublicIp) `
                           -TimeoutSeconds ([int]$cfg.timeoutSeconds)

$system = ConvertTo-Ordered $inventory.data.system
$system.loggedUser = $live.loggedUser
$system.lastBoot = $live.lastBoot
$system.uptimeSeconds = $live.uptimeSeconds

$cpu = ConvertTo-Ordered $inventory.data.cpu
$cpu.loadPercent = Get-CpuLoad

$gpuLoad = [ordered]@{ loadPercent = $null; vramUsedBytes = $null }
if ($cfg.collectGpuLoad) { $gpuLoad = Get-GpuLoad }

$payload = [ordered]@{
    machineId     = Get-MachineId
    hostname      = $env:COMPUTERNAME
    label         = $cfg.label
    agentVersion  = $AgentVersion
    collectedAt   = (Get-Date).ToUniversalTime().ToString('o')
    system        = $system
    cpu           = $cpu
    memory        = $live.memory
    # Les @() sont indispensables : PowerShell deballe un tableau d'un seul
    # element au retour d'une fonction, et ConvertTo-Json le serialiserait
    # alors comme un objet. Un poste avec un seul disque enverrait un
    # "volumes" non iterable cote serveur.
    gpu           = [ordered]@{
        adapters      = @($inventory.data.gpuAdapters)
        loadPercent   = $gpuLoad.loadPercent
        vramUsedBytes = $gpuLoad.vramUsedBytes
    }
    disk          = [ordered]@{
        volumes  = @(Get-DiskUsage)
        physical = @($inventory.data.physicalDisks)
    }
    network       = $network
    vpn           = Get-VpnInfo -Interfaces @($network.interfaces)
    battery       = Get-BatteryInfo
    rebootPending = Get-RebootPending
}

if ($cfg.collectSecurity) { $payload.security = $inventory.data.security }
if ($cfg.collectProcesses) { $payload.topProcesses = @(Get-TopProcesses) }

$payload.collectMs = [int]((Get-Date) - $started).TotalMilliseconds
$json = $payload | ConvertTo-Json -Depth 8 -Compress

if ($Show) {
    Write-Host ''
    Write-Host '=== Rapport Komoku ===' -ForegroundColor Cyan
    $payload | ConvertTo-Json -Depth 8
    Write-Host ''
    $src = 'recalcule'
    if ($inventory.fromCache) { $src = 'depuis le cache' }
    Write-Host ("Collecte en {0} ms (inventaire {1}, charge utile {2} octets)" -f `
        $payload.collectMs, $src, $json.Length) -ForegroundColor DarkGray
    if (-not $cfg.serverUrl) {
        Write-Host 'Aucun serverUrl configure : rien envoye.' -ForegroundColor Yellow
    }
    return
}

if (-not $cfg.serverUrl -or -not $cfg.apiKey) {
    Write-Log 'serverUrl ou apiKey absent de la configuration : envoi annule.' 'ERROR'
    exit 2
}

$endpoint = ($cfg.serverUrl.TrimEnd('/')) + '/api/ingest'
$headers = @{ 'X-Api-Key' = $cfg.apiKey }
$attempt = 0
$maxAttempts = 3

while ($attempt -lt $maxAttempts) {
    $attempt++
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($json)
        Invoke-RestMethod -Uri $endpoint -Method Post -Body $bytes `
            -ContentType 'application/json; charset=utf-8' `
            -Headers $headers -TimeoutSec ([int]$cfg.timeoutSeconds) -ErrorAction Stop | Out-Null
        Write-Log ("Envoi OK ({0} octets, collecte {1} ms)" -f $json.Length, $payload.collectMs)
        exit 0
    } catch {
        $msg = $_.Exception.Message
        $status = $null
        try { $status = [int]$_.Exception.Response.StatusCode } catch {}
        # Une cle refusee ne sera pas acceptee au reessai
        if ($status -eq 401 -or $status -eq 403) {
            Write-Log "Cle API refusee par le serveur (HTTP $status)." 'ERROR'
            exit 3
        }
        Write-Log ("Echec envoi (essai {0}/{1}) : {2}" -f $attempt, $maxAttempts, $msg) 'WARN'
        if ($attempt -lt $maxAttempts) { Start-Sleep -Seconds (5 * $attempt) }
    }
}

Write-Log 'Envoi abandonne apres 3 essais.' 'ERROR'
exit 1
