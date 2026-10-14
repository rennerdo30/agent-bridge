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
  const output = execFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
      input: fileURLToPath(new URL("../scripts/ci-windows-ownership.ps1", import.meta.url)) + "\n" +
        fileURLToPath(new URL("./fixtures/ci-windows-reparse.cs", import.meta.url)) + "\n",
      encoding: "utf8", windowsHide: true,
    });
  return JSON.parse(output.trim().split(/\r?\n/).at(-1)!);
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

it.runIf(process.platform === "win32").each(["ordinary", "marker"])(
  "retains every fixture and outside read-only hard-link metadata (%s)", kind => {
    expect(guard(`
Add-Type -Path $reparseFixture
$outside = Join-Path $parent 'outside-readonly.txt'
$outsideBytes = ${kind === "marker" ? "$owner.MarkerContents" : "'outside owned fixture bytes'"}
[IO.File]::WriteAllText($outside, $outsideBytes)
$link = ${kind === "marker" ? "$marker" : "(Join-Path $owner.Root 'hard-link.txt')"}
${kind === "marker" ? "[IO.File]::Delete($marker)" : ""}
$null = New-Item -ItemType HardLink -Path $link -Target $outside -ErrorAction Stop
[IO.File]::SetAttributes($outside, [IO.FileAttributes]::ReadOnly)
[IO.File]::SetAttributes($sentinel, [IO.FileAttributes]::ReadOnly)
$outsideAttributes = [CiReparseFixture]::ReadFileAttributes($outside)
$ownedAttributes = [CiReparseFixture]::ReadFileAttributes($sentinel)
$outsideReader = [IO.File]::Open($outside, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
try {
    $refused = $false
    $linkProofRefused = $false
    try { Remove-CiOwnedRoot $owner } catch {
        $refused = $true
        $linkProofRefused = $_.Exception.ToString().Contains('exactly one known link')
    }
    [pscustomobject]@{ refused = $refused; linkProofRefused = $linkProofRefused;
        outsideBytes = [IO.File]::ReadAllText($outside) -ceq $outsideBytes;
        outsideAttributes = [CiReparseFixture]::ReadFileAttributes($outside) -eq $outsideAttributes;
        ownedBytes = [IO.File]::ReadAllText($sentinel) -ceq 'owned fixture';
        ownedAttributes = [CiReparseFixture]::ReadFileAttributes($sentinel) -eq $ownedAttributes;
        marker = [IO.File]::ReadAllText($marker) -ceq $owner.MarkerContents;
        root = [IO.Directory]::Exists($owner.Root); link = [IO.File]::Exists($link);
        resource = $outsideReader.CanRead -and $outsideReader.ReadByte() -eq [Text.Encoding]::UTF8.GetBytes($outsideBytes)[0]
    } | ConvertTo-Json -Compress
} finally {
    # Restore only these two fixture endpoints after recording the refusal.
    $outsideReader.Dispose()
    [IO.File]::SetAttributes($outside, [IO.FileAttributes]::Normal)
    [IO.File]::Delete($link)
    ${kind === "marker" ? "[IO.File]::WriteAllText($marker, $owner.MarkerContents)" : ""}
    [IO.File]::Delete($outside)
}
`)).toEqual({ refused: true, linkProofRefused: true, outsideBytes: true, outsideAttributes: true,
      ownedBytes: true, ownedAttributes: true, marker: true, root: true, link: true, resource: true });
  },
);

it.runIf(process.platform === "win32")("retains outside read-only metadata if a link appears after complete proof", () => {
  const result = guard(`
Add-Type -Path $reparseFixture
$outside = Join-Path $parent 'late-hard-link.txt'
$target = Join-Path $owner.Root 'target'
$link = Join-Path $owner.Root 'internal-junction'
$null = New-Item -ItemType Directory -Path $target
$null = New-Item -ItemType Junction -Path $link -Target $target
[IO.File]::SetAttributes($sentinel, [IO.FileAttributes]::ReadOnly)
$attributes = [CiReparseFixture]::ReadFileAttributes($sentinel)
$script:linkError = -1
$afterUnlink = [Action[string]]{
    param($path)
    # The complete proof has finished; a junction has been unlinked. Try a new
    # alias to this test's regular file through the native hard-link operation.
    $script:linkError = [CiReparseFixture]::TryCreateHardLink($outside, $sentinel)
}
try {
    Initialize-CiCleanupApi
    [CiWindowsCleanup]::Remove($owner.Root, $owner.MarkerName, $owner.MarkerContents, $null, $null, $afterUnlink)
    $preserved = if ($script:linkError -eq 0) {
        [IO.File]::ReadAllText($outside) -ceq 'owned fixture' -and [CiReparseFixture]::ReadFileAttributes($outside) -eq $attributes
    } else { -not [IO.File]::Exists($outside) }
    [pscustomobject]@{ linkError = $script:linkError; outsidePreserved = $preserved;
        rootRemoved = -not [IO.Directory]::Exists($owner.Root) } | ConvertTo-Json -Compress
} finally {
    if ([IO.File]::Exists($outside)) {
        # Only this test-created alias after its bytes/flags have been observed.
        [IO.File]::SetAttributes($outside, [IO.FileAttributes]::Normal)
        [IO.File]::Delete($outside)
    }
}
`);
  // A successful creation exercises the late-link path. A sharing refusal is
  // recorded as that platform's control result, not as a topology-lock proof.
  console.info(`Late hard-link control: win32=${result.linkError}`);
  expect([0, 32]).toContain(result.linkError);
  expect(result.outsidePreserved).toBe(true);
  expect(result.rootRemoved).toBe(true);
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

it.runIf(process.platform === "win32")("unlinks a physical internal junction before its target's normal walk, and logs why", () => {
  expect(guard(`
$target = Join-Path $owner.Root 'target'
$link = Join-Path $owner.Root 'internal-junction'
$null = New-Item -ItemType Directory -Path $target
[IO.File]::WriteAllText((Join-Path $target 'keep.txt'), 'target fixture')
$null = New-Item -ItemType Junction -Path $link -Target $target
Initialize-CiCleanupApi
$script:linkEnumerations = 0
$script:targetRetainedAtUnlink = $false
$script:linkRemovedAtUnlink = $false
$beforeEnumeration = [Action[string]]{ param($directory); if ($directory -ceq $link) { $script:linkEnumerations++ } }
$afterUnlink = [Action[string]]{
    param($path)
    $script:targetRetainedAtUnlink = [IO.Directory]::Exists($target) -and (Test-Path -LiteralPath (Join-Path $target 'keep.txt'))
    $script:linkRemovedAtUnlink = -not (Test-Path -LiteralPath $path)
}
$capture = [IO.StringWriter]::new()
$oldOut = [Console]::Out
try {
    [Console]::SetOut($capture)
    [CiWindowsCleanup]::Remove($owner.Root, $owner.MarkerName, $owner.MarkerContents, $null, $beforeEnumeration, $afterUnlink)
} finally { [Console]::SetOut($oldOut) }
$log = $capture.ToString()
[pscustomobject]@{ enumerations = $script:linkEnumerations; targetRetained = $script:targetRetainedAtUnlink;
    linkRemoved = $script:linkRemovedAtUnlink; removed = -not (Test-Path -LiteralPath $owner.Root);
    logged = $log.Contains($link) -and $log.Contains($target) -and $log.Contains('reason=physical directory') } | ConvertTo-Json -Compress
`)).toEqual({ enumerations: 0, targetRetained: true, linkRemoved: true, removed: true, logged: true });
});

it.runIf(process.platform === "win32")("refuses an internal chained junction before deleting anything", () => {
  expect(guard(`
$target = Join-Path $owner.Root 'target'
$first = Join-Path $owner.Root 'first-junction'
$chain = Join-Path $owner.Root 'chained-junction'
$null = New-Item -ItemType Directory -Path $target
[IO.File]::WriteAllText((Join-Path $target 'keep.txt'), 'target fixture')
$null = New-Item -ItemType Junction -Path $first -Target $target
$null = New-Item -ItemType Junction -Path $chain -Target $first
try {
    $refused = $false
    try { Remove-CiOwnedRoot $owner } catch { $refused = $true }
    [pscustomobject]@{ refused = $refused; retained = Test-Path -LiteralPath $sentinel;
        targetRetained = [IO.File]::ReadAllText((Join-Path $target 'keep.txt')) -ceq 'target fixture';
        linksRetained = (Test-Path -LiteralPath $first) -and (Test-Path -LiteralPath $chain) } | ConvertTo-Json -Compress
} finally {
    [IO.Directory]::Delete($chain)
    [IO.Directory]::Delete($first)
}
`)).toEqual({ refused: true, retained: true, targetRetained: true, linksRetained: true });
});

it.runIf(process.platform === "win32")("refuses a target swap between junction validation and deletion", () => {
  expect(guard(`
$target = Join-Path $owner.Root 'target'
$link = Join-Path $owner.Root 'internal-junction'
$outside = Join-Path $parent 'outside'
$null = New-Item -ItemType Directory -Path $target
$null = New-Item -ItemType Directory -Path $outside
[IO.File]::WriteAllText((Join-Path $target 'keep.txt'), 'target fixture')
[IO.File]::WriteAllText((Join-Path $outside 'keep.txt'), 'outside fixture')
$null = New-Item -ItemType Junction -Path $link -Target $target
Initialize-CiCleanupApi
try {
    $swap = [Action]{
        [IO.Directory]::Move($target, ($target + '-moved'))
        $null = New-Item -ItemType Junction -Path $target -Target $outside
    }
    $refused = $false
    try { [CiWindowsCleanup]::Remove($owner.Root, $owner.MarkerName, $owner.MarkerContents, $swap) } catch { $refused = $true }
    [pscustomobject]@{ refused = $refused; retained = Test-Path -LiteralPath $sentinel;
        targetRetained = [IO.File]::ReadAllText((Join-Path $target 'keep.txt')) -ceq 'target fixture';
        outsideRetained = [IO.File]::ReadAllText((Join-Path $outside 'keep.txt')) -ceq 'outside fixture';
        linkRetained = Test-Path -LiteralPath $link } | ConvertTo-Json -Compress
} finally {
    [IO.Directory]::Delete($link)
    [IO.File]::Delete((Join-Path $outside 'keep.txt'))
    [IO.Directory]::Delete($outside)
}
`)).toEqual({ refused: true, retained: true, targetRetained: true, outsideRetained: true, linkRetained: true });
});

it.runIf(process.platform === "win32")("refuses raw dot segments that could hide a reparse hop", () => {
  expect(guard(`
Add-Type -Path $reparseFixture
$target = Join-Path $owner.Root 'target'
$via = Join-Path $owner.Root 'via'
$link = Join-Path $owner.Root 'raw-junction'
$null = New-Item -ItemType Directory -Path $target
$null = New-Item -ItemType Directory -Path $via
$null = New-Item -ItemType Directory -Path $link
$created = [CiReparseFixture]::ConvertToJunctionRaw($link, ($via + '\\..\\target'))
try {
    $refused = $false
    $noncanonical = $false
    try { Remove-CiOwnedRoot $owner } catch {
        $refused = $true
        $noncanonical = $_.Exception.ToString().Contains('noncanonical junction target')
    }
    [pscustomobject]@{ created = $created; refused = $refused; noncanonical = $noncanonical;
        retained = Test-Path -LiteralPath $sentinel; targetRetained = Test-Path -LiteralPath $target } | ConvertTo-Json -Compress
} finally { [IO.Directory]::Delete($link) }
`)).toEqual({ created: 0, refused: true, noncanonical: true, retained: true, targetRetained: true });
});

it.runIf(process.platform === "win32")("permits compatible existing writers without releasing directory identity pins", () => {
  expect(guard(`
Add-Type -Path $reparseFixture
$ancestorWriter = [CiReparseFixture]::HoldWriteDirectory($parent)
$fileWriter = [IO.File]::Open($sentinel, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
try {
    Initialize-CiCleanupApi
    $script:ancestorSwapBlocked = $false
    $settleWriter = [Action]{
        try { [IO.Directory]::Move($parent, ($parent + '-moved')) } catch { $script:ancestorSwapBlocked = $true }
        $fileWriter.Dispose()
    }
    [CiWindowsCleanup]::Remove($owner.Root, $owner.MarkerName, $owner.MarkerContents, $settleWriter)
    [pscustomobject]@{ removed = -not (Test-Path -LiteralPath $owner.Root); ancestorSwapBlocked = $script:ancestorSwapBlocked } | ConvertTo-Json -Compress
} finally {
    $fileWriter.Dispose()
    $ancestorWriter.Dispose()
}
`)).toEqual({ removed: true, ancestorSwapBlocked: true });
});

it.runIf(process.platform === "win32")("tolerates a fixture child disappearing between enumeration and opening", () => {
  expect(guard(`
Initialize-CiCleanupApi
$script:disappeared = $false
$beforeOpen = [Action[string]]{
    param($path)
    if ($path -ceq $sentinel) { [IO.File]::Delete($path); $script:disappeared = $true }
}
[CiWindowsCleanup]::Remove($owner.Root, $owner.MarkerName, $owner.MarkerContents, $null, $null, $null, $beforeOpen)
[pscustomobject]@{ disappeared = $script:disappeared; removed = -not (Test-Path -LiteralPath $owner.Root) } | ConvertTo-Json -Compress
`)).toEqual({ disappeared: true, removed: true });
});

it.runIf(process.platform === "win32")("still refuses when its marker disappears during enumeration", () => {
  expect(guard(`
Initialize-CiCleanupApi
$beforeOpen = [Action[string]]{ param($path); if ($path -ceq $marker) { [IO.File]::Delete($path) } }
try {
    $refused = $false
    try { [CiWindowsCleanup]::Remove($owner.Root, $owner.MarkerName, $owner.MarkerContents, $null, $null, $null, $beforeOpen) } catch { $refused = $true }
    [pscustomobject]@{ refused = $refused; retained = [IO.File]::ReadAllText($sentinel) -ceq 'owned fixture' } | ConvertTo-Json -Compress
} finally { [IO.File]::WriteAllText($marker, $owner.MarkerContents) }
`)).toEqual({ refused: true, retained: true });
});
