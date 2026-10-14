<#
.SYNOPSIS
Run the existing fast and integration lanes in a fresh Windows CI-like fixture root.
.DESCRIPTION
Uses CI=1 and an inheritance-protected ACL with explicit, inheritable FullControl
entries for the current user, SYSTEM and Administrators. TEMP/TMP and the bridge
test home point inside this root. -Throttle uses BelowNormal priority and one
currently allowed CPU. The former experimental FreshVolume implementation is
retained below for separate review. FreshVolume is currently refused at entry:
administrator/VHD support is
unavailable pending a separately reviewed owned-handle lifecycle mechanism.
No disk/partition/mount/format/access-path command can run through this entry.

Cannot reproduce the hosted runner's Windows Server image, token/default object
owner, NTFS file-ID magnitude/reuse, antivirus, disk/network latency, installed
tools, CPU model or contention from other tenants. A fresh VHD is not a guarantee
of >2^53 file IDs. Throttle approximates CPU contention, not IO latency.
No elevation is requested. Tests/assertions/deadlines are unchanged. An interrupted
or forcibly killed shell may leave its marked root/VHD for manual inspection.
Cleanup verifies its unique token-plus-path marker and refuses unproven links.
Proven internal directory junctions are unlinked by handle without target traversal.
VHD detach verifies the recorded path and actual VHD GUID.
Never point this script at an existing volume or an existing fixture root.
.EXAMPLE
npm run test:ci-windows -- -Throttle
npm run test:ci-windows -- -FreshVolume --shard=1/4
npm run test:ci-windows -- -Lane integration test/mobile-identity.test.ts
#>
[CmdletBinding()]
param(
    [switch]$FreshVolume,
    [switch]$Throttle,
    [switch]$CollectOnly,
    [ValidateSet('all', 'fast', 'integration')][string]$Lane = 'all',
    [string]$NodePath = 'node',
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$TestArgs
)
if ($FreshVolume) {
    Write-Error -ErrorAction Continue 'FreshVolume unavailable: administrator/VHD support requires a separately reviewed owned-handle mechanism. No volume or fixture mutation was attempted.'
    exit 1
}
$ErrorActionPreference = 'Stop'
$repository = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'ci-windows-ownership.ps1')
# Compile while this process still uses its incoming temporary directory. Lazy
# Add-Type during cleanup would put compiler inputs in the fixture being removed.
# A compilation failure aborts before any fixture or ownership root is created.
Initialize-CiCleanupApi
$owner = New-CiOwnership ([IO.Path]::GetTempPath())
$token = $owner.Token
$root = $owner.Root
$vhd = Join-Path $root 'fixtures.vhdx'
$mountAttempted = $false
$exitCode = 1
$process = Get-Process -Id $PID
$oldPriority = $process.PriorityClass
$oldAffinity = $process.ProcessorAffinity

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

try {
    Initialize-CiOwnedRoot $owner
    Set-RunnerAcl $root
    $fixtures = Join-Path $root 'f'
    if ($FreshVolume) {
        $admin = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
        if (-not $admin.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
            Write-Host 'FreshVolume skipped: administrator rights are required; using a fresh ACL-isolated folder.'
        } elseif (-not (Get-Command Mount-DiskImage -ErrorAction SilentlyContinue)) {
            Write-Host 'FreshVolume skipped: Windows Storage cmdlets are unavailable; using a fresh ACL-isolated folder.'
        } else {
            Assert-CiOwnedRoot $owner
            Assert-CiOwnedEntry $owner $vhd
            if (Test-Path -LiteralPath $vhd) { throw 'Refusing an existing VHDX' }
            $createScript = Join-Path $root 'create-vhd.txt'
            [IO.File]::WriteAllText($createScript, "create vdisk file=`"$vhd`" maximum=4096 type=expandable`r`nexit`r`n")
            & (Join-Path $env:SystemRoot 'System32\diskpart.exe') /s $createScript
            if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $vhd -PathType Leaf)) { throw 'Creating the new VHDX failed' }
            Assert-CiOwnedEntry $owner $vhd
            $owner.Vhd = [pscustomobject]@{ Created = $true; Path = $vhd; Guid = (Get-CiVhdGuid $vhd); MountPath = $null }
            Assert-CiOwnedVhd $owner $vhd
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
            $owner.Vhd.MountPath = $mount
            Add-PartitionAccessPath -DiskNumber $disk.Number -PartitionNumber $partition.PartitionNumber -AccessPath ($mount + '\')
            $fixtures = Join-Path $mount 'f'
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
        if ($CollectOnly) {
            if ($Lane -ne 'all' -or $TestArgs.Count -ne 0) { throw 'CollectOnly requires both unfiltered lanes' }
            $results = if ($env:AGENT_BRIDGE_CI_RESULTS_DIR) { $env:AGENT_BRIDGE_CI_RESULTS_DIR } else { '.agent-bridge-test/ci' }
            & $NodePath (Join-Path $PSScriptRoot 'check-test-shards.mjs') 4 (Join-Path $results 'shards.json') --collect
            $exitCode = $LASTEXITCODE
        } else {
            $lanes = if ($Lane -eq 'all') { @('fast', 'integration') } else { @($Lane) }
            foreach ($testLane in $lanes) {
                & $NodePath (Join-Path $PSScriptRoot 'test.mjs') $testLane @TestArgs
                if ($LASTEXITCODE -ne 0) { $exitCode = $LASTEXITCODE }
            }
        }
    } finally { Pop-Location }
} catch {
    Write-Error -ErrorAction Continue $_
    $exitCode = 1
} finally {
    try {
        if ($mountAttempted) {
            # Always detach our exact image, including after a partial mount/format failure.
            Assert-CiOwnedVhd $owner $vhd
            $image = Get-DiskImage -ImagePath $vhd
            if ($image.Attached) {
                # Remove only our access path on our verified image. This clears the
                # volume reparse point before the no-links cleanup preflight.
                if ($owner.Vhd.MountPath) {
                    if ($owner.Vhd.MountPath -cne (Join-Path $root 'volume')) { throw 'VHD mount path changed' }
                    $accessPath = $owner.Vhd.MountPath + '\'
                    $disks = @($image | Get-Disk)
                    if ($disks.Count -ne 1 -or $disks[0].IsBoot -or $disks[0].IsSystem) { throw 'Unexpected VHD disk during detach' }
                    foreach ($partition in @($disks[0] | Get-Partition)) {
                        if ($partition.AccessPaths -contains $accessPath) {
                            Remove-PartitionAccessPath -DiskNumber $disks[0].Number -PartitionNumber $partition.PartitionNumber -AccessPath $accessPath
                        }
                    }
                }
                Dismount-CiOwnedVhd $owner $vhd
            }
            if ((Get-DiskImage -ImagePath $vhd).Attached) { throw 'VHDX detach failed; retaining its root' }
            Write-Host 'FreshVolume: detached disposable VHDX.'
        }
        if (Test-Path -LiteralPath $root) {
            Remove-CiOwnedRoot $owner
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
