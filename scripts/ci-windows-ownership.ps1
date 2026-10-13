# Shared with the regression tests. Dot-sourcing defines guards without running tests/VHD work.
function New-CiOwnership([string]$TempParent) {
    $parent = [IO.Path]::GetFullPath($TempParent).TrimEnd('\')
    $token = [guid]::NewGuid().ToString('N')
    $root = Join-Path $parent ('abci-' + $token)
    [pscustomobject]@{ Parent = $parent; Token = $token; Root = $root;
        MarkerName = '.ab-ci-windows-owner'; MarkerContents = "$token`n$root";
        Created = $false; Vhd = $null }
}

function Assert-CiPhysicalPath([string]$Path, [switch]$OutsideRepository) {
    $absolute = [IO.Path]::GetFullPath($Path)
    $component = [IO.Path]::GetPathRoot($absolute)
    # Walk from the drive outward: never inspect a child through a linked ancestor.
    $parts = @('') + @($absolute.Substring($component.Length).Split('\', [StringSplitOptions]::RemoveEmptyEntries))
    foreach ($part in $parts) {
        if ($part) { $component = Join-Path $component $part }
        try { $item = Get-Item -LiteralPath $component -Force -ErrorAction Stop }
        catch [System.Management.Automation.ItemNotFoundException] { break }
        if ($null -ne $item) {
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Refusing a linked fixture/cleanup path: $component"
            }
            if ($OutsideRepository -and $item.PSIsContainer -and
                (Test-Path -LiteralPath (Join-Path $component '.git'))) { throw 'Fixtures must be outside every repository' }
        }
    }
}

function Assert-CiOwnedRoot($Owner) {
    if (-not $Owner.Created) { throw 'This invocation did not create the cleanup root' }
    $expected = Join-Path $Owner.Parent ('abci-' + $Owner.Token)
    if (-not [string]::Equals($Owner.Root, $expected, [StringComparison]::Ordinal) -or
        $Owner.MarkerContents -cne "$($Owner.Token)`n$expected") { throw 'Cleanup root changed' }
    Assert-CiPhysicalPath $Owner.Root -OutsideRepository
    $marker = Join-Path $Owner.Root $Owner.MarkerName
    Assert-CiPhysicalPath $marker
    $item = Get-Item -LiteralPath $marker -Force
    if ($item.PSIsContainer -or [IO.File]::ReadAllText($marker) -cne $Owner.MarkerContents) {
        throw 'Cleanup marker missing or changed; retaining fixtures'
    }
}

function Initialize-CiOwnedRoot($Owner) {
    Assert-CiPhysicalPath $Owner.Root -OutsideRepository
    $null = New-Item -ItemType Directory -Path $Owner.Root -ErrorAction Stop
    $Owner.Created = $true
    # CreateNew refuses to overwrite even a marker introduced between these operations.
    $stream = [IO.File]::Open((Join-Path $Owner.Root $Owner.MarkerName), [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($Owner.MarkerContents)
        $stream.Write($bytes, 0, $bytes.Length)
    } finally { $stream.Dispose() }
}

function Assert-CiOwnedEntry($Owner, [string]$Path) {
    Assert-CiOwnedRoot $Owner
    $absolute = [IO.Path]::GetFullPath($Path)
    if (-not $absolute.StartsWith($Owner.Root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Cleanup escaped its root' }
    Assert-CiPhysicalPath $absolute
}

function Remove-CiOwnedRoot($Owner) {
    Assert-CiOwnedRoot $Owner
    Initialize-CiCleanupApi
    [CiWindowsCleanup]::Remove($Owner.Root, $Owner.MarkerName, $Owner.MarkerContents)
}

function Initialize-CiCleanupApi {
    if ('CiWindowsCleanup' -as [type]) { return }
    Add-Type -Path (Join-Path $PSScriptRoot 'ci-windows-cleanup.cs')
}

function Assert-CiOwnedVhd($Owner, [string]$Path) {
    Assert-CiOwnedEntry $Owner $Path
    if ($null -eq $Owner.Vhd -or -not $Owner.Vhd.Created -or
        $Owner.Vhd.Path -cne $Path -or $Path -cne (Join-Path $Owner.Root 'fixtures.vhdx') -or
        [guid]$Owner.Vhd.Guid -eq [guid]::Empty) { throw 'VHD was not created and recorded by this invocation' }
    if ((Get-CiVhdGuid $Path) -ne [guid]$Owner.Vhd.Guid) { throw 'VHD GUID changed; refusing detach' }
}

function Get-CiVhdGuid([string]$Path) {
    Initialize-CiVhdApi
    [CiWindowsVhd]::ReadGuid($Path)
}

function Dismount-CiOwnedVhd($Owner, [string]$Path) {
    Assert-CiOwnedVhd $Owner $Path
    # Verify again on the same native handle used to detach, avoiding path substitution.
    [CiWindowsVhd]::Detach($Path, [guid]$Owner.Vhd.Guid)
}

function Initialize-CiVhdApi {
    if ('CiWindowsVhd' -as [type]) { return }
    Add-Type -Path (Join-Path $PSScriptRoot 'ci-windows-vhd.cs')
}
