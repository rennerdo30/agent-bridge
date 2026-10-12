<#
.SYNOPSIS
Run the existing fast and integration lanes in a fresh Windows CI-like fixture root.
.DESCRIPTION
Uses CI=1 and an inheritance-protected ACL with explicit, inheritable FullControl
entries for the current user, SYSTEM and Administrators. TEMP/TMP and the bridge
test home point inside this root. -Throttle uses BelowNormal priority and one
currently allowed CPU. -FreshVolume creates a new 4 GiB dynamic VHDX, formats ONLY
that newly attached disk as NTFS, and mounts it for fixtures; requires admin.

Cannot reproduce the hosted runner's Windows Server image, token/default object
owner, NTFS file-ID magnitude/reuse, antivirus, disk/network latency, installed
tools, CPU model or contention from other tenants. A fresh VHD is not a guarantee
of >2^53 file IDs. Throttle approximates CPU contention, not IO latency.
No elevation is requested. Tests/assertions/deadlines are unchanged. An interrupted
or forcibly killed shell may leave its marked root/VHD for manual inspection.
Cleanup verifies its unique marker and unlinks reparse points without following
them. Never point this script at an existing volume or an existing fixture root.
.EXAMPLE
npm run test:ci-windows -- -Throttle
npm run test:ci-windows -- -FreshVolume --shard=1/4
npm run test:ci-windows -- -Lane integration test/mobile-identity.test.ts
#>
[CmdletBinding()]
param(
    [switch]$FreshVolume,
    [switch]$Throttle,
    [ValidateSet('all', 'fast', 'integration')][string]$Lane = 'all',
    [string]$NodePath = 'node',
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$TestArgs
)
$ErrorActionPreference = 'Stop'
$repository = Split-Path -Parent $PSScriptRoot
$token = [guid]::NewGuid().ToString('N')
$tempParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$root = Join-Path $tempParent ('ab-ci-windows-' + $token)
$markerName = '.ab-ci-windows-owner'
$vhd = Join-Path $root 'fixtures.vhdx'
$mountAttempted = $false
$exitCode = 1
$process = Get-Process -Id $PID
$oldPriority = $process.PriorityClass
$oldAffinity = $process.ProcessorAffinity

function Assert-PhysicalPath([string]$Path) {
    for ($component = [IO.Path]::GetFullPath($Path); $component; $component = Split-Path -Parent $component) {
        if (Test-Path -LiteralPath $component) {
            if ((Get-Item -LiteralPath $component -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Refusing a linked fixture/cleanup path: $component"
            }
            if (Test-Path -LiteralPath (Join-Path $component '.git')) { throw 'Fixtures must be outside every repository' }
        }
    }
}
function Assert-OwnedRoot {
    Assert-PhysicalPath $root
    $expected = Join-Path $tempParent ('ab-ci-windows-' + $token)
    if ([IO.Path]::GetFullPath($root) -ne [IO.Path]::GetFullPath($expected)) { throw 'Cleanup root changed' }
    $marker = Join-Path $root $markerName
    $item = Get-Item -LiteralPath $marker -Force
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        [IO.File]::ReadAllText($marker) -ne $token) { throw 'Cleanup marker missing or changed; retaining fixtures' }
}
function Set-RunnerAcl([string]$Path) {
    $acl = New-Object System.Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $caller = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl.SetOwner($caller)
    foreach ($sid in @($caller.Value, 'S-1-5-18', 'S-1-5-32-544') | Select-Object -Unique) {
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
            [Security.Principal.SecurityIdentifier]::new($sid), 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
}
function Remove-OwnedEntry([string]$Path) {
    $absolute = [IO.Path]::GetFullPath($Path)
    if (-not $absolute.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Cleanup escaped its root' }
    $item = Get-Item -LiteralPath $absolute -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        # Directory.Delete with no recursive flag removes the link, never its target.
        if ($item.PSIsContainer) { [IO.Directory]::Delete($absolute) } else { [IO.File]::Delete($absolute) }
    } elseif ($item.PSIsContainer) {
        foreach ($child in Get-ChildItem -LiteralPath $absolute -Force) { Remove-OwnedEntry $child.FullName }
        [IO.Directory]::Delete($absolute)
    } else {
        if ($item.IsReadOnly) { $item.IsReadOnly = $false }
        [IO.File]::Delete($absolute)
    }
}

try {
    Assert-PhysicalPath $tempParent
    # New-Item without -Force must fail on any collision; never adopt existing data.
    $null = New-Item -ItemType Directory -Path $root
    [IO.File]::WriteAllText((Join-Path $root $markerName), $token)
    Set-RunnerAcl $root
    $fixtures = Join-Path $root 'fixtures'
    if ($FreshVolume) {
        $admin = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
        if (-not $admin.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
            Write-Host 'FreshVolume skipped: administrator rights are required; using a fresh ACL-isolated folder.'
        } elseif (-not (Get-Command Mount-DiskImage -ErrorAction SilentlyContinue)) {
            Write-Host 'FreshVolume skipped: Windows Storage cmdlets are unavailable; using a fresh ACL-isolated folder.'
        } else {
            Assert-OwnedRoot
            $createScript = Join-Path $root 'create-vhd.txt'
            [IO.File]::WriteAllText($createScript, "create vdisk file=`"$vhd`" maximum=4096 type=expandable`r`nexit`r`n")
            & (Join-Path $env:SystemRoot 'System32\diskpart.exe') /s $createScript
            if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $vhd -PathType Leaf)) { throw 'Creating the new VHDX failed' }
            Assert-PhysicalPath $vhd
            $mountAttempted = $true
            $image = Mount-DiskImage -ImagePath $vhd -NoDriveLetter -PassThru
            if ($image.ImagePath -ne $vhd -or -not $image.Attached) { throw 'Unexpected mounted image' }
            $disks = @($image | Get-Disk)
            if ($disks.Count -ne 1 -or $disks[0].PartitionStyle -ne 'RAW' -or $disks[0].IsBoot -or $disks[0].IsSystem) {
                throw 'Refusing to format anything except the new blank VHDX'
            }
            $disk = $disks[0] | Initialize-Disk -PartitionStyle GPT -PassThru
            $partition = New-Partition -DiskNumber $disk.Number -UseMaximumSize
            $null = Format-Volume -Partition $partition -FileSystem NTFS -NewFileSystemLabel ('ABCI-' + $token.Substring(0, 8)) -Confirm:$false
            $mount = Join-Path $root 'volume'
            $null = New-Item -ItemType Directory -Path $mount
            Add-PartitionAccessPath -DiskNumber $disk.Number -PartitionNumber $partition.PartitionNumber -AccessPath ($mount + '\')
            $fixtures = Join-Path $mount 'fixtures'
            Write-Host 'FreshVolume: new disposable NTFS VHDX mounted for fixtures.'
        }
    }
    $null = New-Item -ItemType Directory -Path $fixtures
    Set-RunnerAcl $fixtures
    $fixtureTemp = Join-Path $fixtures 'temp'
    $null = New-Item -ItemType Directory -Path $fixtureTemp
    $env:TEMP = $fixtureTemp
    $env:TMP = $fixtureTemp
    $env:TMPDIR = $fixtureTemp
    $env:AGENT_BRIDGE_TEST_ROOT = $fixtures
    $env:AGENT_BRIDGE_TEST_TEMP_ROOT = $fixtures
    $env:AGENT_BRIDGE_HOME = Join-Path $fixtures 'default-home'
    $env:AGENT_BRIDGE_CI_WINDOWS = '1'
    $env:CI = 'true'
    if ($Throttle) {
        $process.PriorityClass = 'BelowNormal'
        $allowed = $oldAffinity.ToInt64()
        $process.ProcessorAffinity = [IntPtr]($allowed -band (-$allowed))
        Write-Host 'Throttle: BelowNormal priority and one allowed CPU (inherited by children).'
    }
    Write-Host "CI-like Windows fixtures: $fixtures"
    Write-Host 'ACL: inheritance disabled; explicit user + SYSTEM + Administrators. Tests use unchanged lane deadlines.'
    Push-Location $repository
    try {
        $exitCode = 0
        $lanes = if ($Lane -eq 'all') { @('fast', 'integration') } else { @($Lane) }
        foreach ($testLane in $lanes) {
            & $NodePath (Join-Path $PSScriptRoot 'test.mjs') $testLane @TestArgs
            if ($LASTEXITCODE -ne 0) { $exitCode = $LASTEXITCODE }
        }
    } finally { Pop-Location }
} catch {
    Write-Error -ErrorAction Continue $_
    $exitCode = 1
} finally {
    try {
        if ($mountAttempted) {
            # Always detach our exact image, including after a partial mount/format failure.
            Assert-PhysicalPath $vhd
            $image = Get-DiskImage -ImagePath $vhd
            if ($image.Attached) { Dismount-DiskImage -ImagePath $vhd }
            if ((Get-DiskImage -ImagePath $vhd).Attached) { throw 'VHDX detach failed; retaining its root' }
            Write-Host 'FreshVolume: detached disposable VHDX.'
        }
        if (Test-Path -LiteralPath $root) {
            Assert-OwnedRoot
            foreach ($item in Get-ChildItem -LiteralPath $root -Force | Where-Object Name -ne $markerName) { Remove-OwnedEntry $item.FullName }
            Assert-OwnedRoot
            [IO.File]::Delete((Join-Path $root $markerName))
            [IO.Directory]::Delete($root)
            Write-Host 'Cleanup: removed only the verified marked root created by this invocation.'
        }
    } catch {
        Write-Error -ErrorAction Continue "Cleanup refused/failed; retaining $root for inspection: $_"
        $exitCode = 1
    }
    # Restoring an unusual inherited priority can fail without privileges.
    # It must never prevent detaching our VHD or checking the cleanup marker.
    try {
        $process.PriorityClass = $oldPriority
        $process.ProcessorAffinity = $oldAffinity
    } catch {
        Write-Error -ErrorAction Continue "Restoring this runner process priority/affinity failed: $_"
        $exitCode = 1
    }
}
exit $exitCode
