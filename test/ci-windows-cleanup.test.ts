import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

function guard(body: string) {
  const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
. ([Console]::In.ReadLine())
$reparseFixture = [Console]::In.ReadLine()
$parent = Join-Path ([IO.Path]::GetTempPath()) ('abci-guard-' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $parent
$owner = New-CiOwnership $parent
Initialize-CiOwnedRoot $owner
$sentinel = Join-Path $owner.Root 'sentinel.txt'
[IO.File]::WriteAllText($sentinel, 'owned fixture')
$marker = Join-Path $owner.Root $owner.MarkerName
try {
${body}
} finally {
    # Each negative case restores only its own fixture before guarded cleanup.
    if (Test-Path -LiteralPath $owner.Root) { Remove-CiOwnedRoot $owner }
    [IO.Directory]::Delete($parent)
}
`;
  return JSON.parse(execFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
      input: fileURLToPath(new URL("../scripts/ci-windows-ownership.ps1", import.meta.url)) + "\n" +
        fileURLToPath(new URL("./fixtures/ci-windows-reparse.cs", import.meta.url)) + "\n",
      encoding: "utf8", windowsHide: true,
    }));
}

it.runIf(process.platform === "win32")("retains all fixtures when the creation marker is missing", () => {
  expect(guard(`
[IO.File]::Delete($marker)
$refused = $false
try { Remove-CiOwnedRoot $owner } catch { $refused = $true }
[pscustomobject]@{ refused = $refused; retained = [IO.File]::ReadAllText($sentinel) -ceq 'owned fixture' } | ConvertTo-Json -Compress
[IO.File]::WriteAllText($marker, $owner.MarkerContents)
`)).toEqual({ refused: true, retained: true });
});

it.runIf(process.platform === "win32")("requires the exact random token and path, and refuses an uncreated root", () => {
  expect(guard(`
$refusals = 0
foreach ($contents in @($owner.Token, ($owner.MarkerContents + [Environment]::NewLine), ($owner.Token + "\n" + $parent))) {
    [IO.File]::WriteAllText($marker, $contents)
    try { Remove-CiOwnedRoot $owner } catch { $refusals++ }
}
[IO.File]::WriteAllText($marker, $owner.MarkerContents)
$owner.Created = $false
try { Remove-CiOwnedRoot $owner } catch { $refusals++ }
$owner.Created = $true
[pscustomobject]@{ refusals = $refusals; retained = Test-Path -LiteralPath $sentinel } | ConvertTo-Json -Compress
`)).toEqual({ refusals: 4, retained: true });
});

it.runIf(process.platform === "win32")("refuses an outside junction before deleting any fixture or target", () => {
  expect(guard(`
$outside = Join-Path $parent 'outside'
$null = New-Item -ItemType Directory -Path $outside
$outsideSentinel = Join-Path $outside 'outside.txt'
[IO.File]::WriteAllText($outsideSentinel, 'outside fixture')
$link = Join-Path $owner.Root 'junction'
$null = New-Item -ItemType Junction -Path $link -Target $outside
try {
    $refused = $false
    try { Remove-CiOwnedRoot $owner } catch { $refused = $true }
    $childRefused = $false
    try { Assert-CiOwnedEntry $owner (Join-Path $link 'outside.txt') } catch { $childRefused = $true }
    [pscustomobject]@{ refused = $refused; childRefused = $childRefused;
        retained = Test-Path -LiteralPath $sentinel;
        outsideRetained = [IO.File]::ReadAllText($outsideSentinel) -ceq 'outside fixture';
        linkRetained = [bool]((Get-Item -LiteralPath $link -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)
    } | ConvertTo-Json -Compress
} finally {
    # This test created both endpoints. Nonrecursive Delete removes only the link.
    [IO.Directory]::Delete($link)
    [IO.File]::Delete($outsideSentinel)
    [IO.Directory]::Delete($outside)
}
`)).toEqual({ refused: true, childRefused: true, retained: true, outsideRetained: true, linkRetained: true });
});

it.runIf(process.platform === "win32")("refuses cleanup entries outside its temp root", () => {
  expect(guard(`
$outside = Join-Path $parent 'outside.txt'
[IO.File]::WriteAllText($outside, 'outside fixture')
try {
    $refused = $false
    try { Assert-CiOwnedEntry $owner $outside } catch { $refused = $true }
    [pscustomobject]@{ refused = $refused; retained = [IO.File]::ReadAllText($outside) -ceq 'outside fixture' } | ConvertTo-Json -Compress
} finally { [IO.File]::Delete($outside) }
`)).toEqual({ refused: true, retained: true });
});

it.runIf(process.platform === "win32")("refuses VHD detach without its creation record, exact path and GUID", () => {
  expect(guard(`
function Get-CiVhdGuid([string]$Path) { [guid]'d53a7897-397e-4f41-a0fd-04bd579c9e6b' }
$vhd = Join-Path $owner.Root 'fixtures.vhdx'
[IO.File]::WriteAllText($vhd, 'stub; never mounted')
$refusals = 0
try { Dismount-CiOwnedVhd $owner $vhd } catch { $refusals++ }
$owner.Vhd = [pscustomobject]@{ Created = $false; Path = $vhd; Guid = [guid]'d53a7897-397e-4f41-a0fd-04bd579c9e6b' }
try { Dismount-CiOwnedVhd $owner $vhd } catch { $refusals++ }
$owner.Vhd.Created = $true
$owner.Vhd.Path = Join-Path $owner.Root 'foreign.vhdx'
try { Dismount-CiOwnedVhd $owner $vhd } catch { $refusals++ }
$owner.Vhd.Path = $vhd
$owner.Vhd.Guid = [guid]::Empty
try { Dismount-CiOwnedVhd $owner $vhd } catch { $refusals++ }
$owner.Vhd.Guid = [guid]'2f2f7ce5-3ff6-412f-a9a1-c7c7b44ad3a5'
try { Dismount-CiOwnedVhd $owner $vhd } catch { $refusals++ }
$owner.Vhd.Guid = [guid]'d53a7897-397e-4f41-a0fd-04bd579c9e6b'
Assert-CiOwnedVhd $owner $vhd
[pscustomobject]@{ refusals = $refusals; retained = Test-Path -LiteralPath $vhd } | ConvertTo-Json -Compress
`)).toEqual({ refusals: 5, retained: true });
});

it.runIf(process.platform === "win32")("removes a verified root using its exact creation marker", () => {
  expect(guard(`
$exact = [IO.File]::ReadAllText($marker) -ceq ($owner.Token + "\n" + $owner.Root)
[IO.File]::SetAttributes($sentinel, [IO.FileAttributes]::ReadOnly)
Remove-CiOwnedRoot $owner
[pscustomobject]@{ exact = $exact; removed = -not (Test-Path -LiteralPath $owner.Root) } | ConvertTo-Json -Compress
`)).toEqual({ exact: true, removed: true });
});

it.runIf(process.platform === "win32")("pins identities against an outside junction swap after cleanup validation", () => {
  expect(guard(`
$outside = Join-Path $parent 'outside'
$inside = Join-Path $owner.Root 'inside'
$null = New-Item -ItemType Directory -Path $outside
$null = New-Item -ItemType Directory -Path $inside
$outsideSentinel = Join-Path $outside 'sentinel.txt'
[IO.File]::WriteAllText($outsideSentinel, 'outside fixture')
[IO.File]::WriteAllText((Join-Path $inside 'sentinel.txt'), 'inside fixture')
Initialize-CiCleanupApi
$script:blocked = 0
try {
    $attemptSwap = [Action]{
        # This is the precise point where path-only validation previously raced.
        try { [IO.Directory]::Move($inside, ($inside + '-moved')) } catch { $script:blocked++ }
        try { $null = New-Item -ItemType Junction -Path $inside -Target $outside -ErrorAction Stop } catch { $script:blocked++ }
        try { [IO.File]::Move($marker, ($marker + '-moved')) } catch { $script:blocked++ }
        try { [IO.Directory]::Move($owner.Root, ($owner.Root + '-moved')) } catch { $script:blocked++ }
        try { [IO.Directory]::Move($parent, ($parent + '-moved')) } catch { $script:blocked++ }
    }
    [CiWindowsCleanup]::Remove($owner.Root, $owner.MarkerName, $owner.MarkerContents, $attemptSwap)
    [pscustomobject]@{ blocked = $script:blocked; removed = -not (Test-Path -LiteralPath $owner.Root);
        outsideRetained = [IO.File]::ReadAllText($outsideSentinel) -ceq 'outside fixture' } | ConvertTo-Json -Compress
} finally {
    [IO.File]::Delete($outsideSentinel)
    [IO.Directory]::Delete($outside)
}
`)).toEqual({ blocked: 5, removed: true, outsideRetained: true });
});

it.runIf(process.platform === "win32")("blocks in-place junction conversion immediately before directory enumeration", () => {
  expect(guard(`
Add-Type -Path $reparseFixture
$outside = Join-Path $parent 'outside'
$inside = Join-Path $owner.Root 'inside'
$probe = Join-Path $parent 'probe'
$null = New-Item -ItemType Directory -Path $outside
$null = New-Item -ItemType Directory -Path $inside
$null = New-Item -ItemType Directory -Path $probe
$outsideSentinel = Join-Path $outside 'outside.txt'
[IO.File]::WriteAllText($outsideSentinel, 'outside fixture')
try {
    # Prove the native fixture can convert an unpinned empty directory in place.
    $baseline = [CiReparseFixture]::ConvertToJunction($probe, $outside)
    $script:conversionError = -1
    Initialize-CiCleanupApi
    $attemptConversion = [Action[string]]{
        param($directory)
        if ($directory -ceq $inside) {
            $script:conversionError = [CiReparseFixture]::ConvertToJunction($directory, $outside)
        }
    }
    [CiWindowsCleanup]::Remove($owner.Root, $owner.MarkerName, $owner.MarkerContents, $null, $attemptConversion)
    [pscustomobject]@{ baseline = $baseline; conversionError = $script:conversionError;
        removed = -not (Test-Path -LiteralPath $owner.Root);
        outsideRetained = [IO.File]::ReadAllText($outsideSentinel) -ceq 'outside fixture' } | ConvertTo-Json -Compress
} finally {
    [IO.Directory]::Delete($probe) # Only this test's link; never recursive.
    [IO.File]::Delete($outsideSentinel)
    [IO.Directory]::Delete($outside)
}
`)).toEqual({ baseline: 0, conversionError: 32, removed: true, outsideRetained: true });
});
