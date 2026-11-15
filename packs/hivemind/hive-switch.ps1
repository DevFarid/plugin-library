# Hivemind Swarm v2.5 stack + topology switcher.
# ASCII-only on purpose: Windows PowerShell 5.1 reads BOM-less scripts as ANSI.
#
# Thin Windows entrypoint. Switching, status, list, validate, model-tier
# preflight, and skill staging all live in bin/hive-switch.cjs so Windows,
# macOS, and Linux share one implementation.
param(
    [Parameter(Position=0)][string]$Command = "status",
    [Parameter(Position=1)][string]$Target = ""
)

$ErrorActionPreference = "Stop"
$HivemindHome = if ($env:HIVEMIND_HOME) { $env:HIVEMIND_HOME } else { Join-Path $HOME ".config\hivemind" }

# Managed subagents that receive routed model tiers and step budgets from every
# profile via bin/hive-switch.cjs include "pr-reviewer" and "swarm-agent-updater".

# Resolve the shared Node backend. An installed layout wins over a repo checkout
# so a stale pack copy can never shadow the managed one.
$Backend = $null
foreach ($Candidate in @(
    (Join-Path $HivemindHome "bin\hive-switch.cjs"),
    (Join-Path $PSScriptRoot "bin\hive-switch.cjs"),
    (Join-Path $PSScriptRoot "hive-switch.cjs")
)) {
    if (Test-Path $Candidate) { $Backend = $Candidate; break }
}
if (-not $Backend) {
    [Console]::Error.WriteLine("[hive-switch] ERROR: missing bin/hive-switch.cjs. Re-run install.ps1 to install the switcher backend into $HivemindHome.")
    exit 1
}

function Resolve-HiveNode {
    if (-not [string]::IsNullOrWhiteSpace($env:HIVEMIND_NODE)) {
        $Configured = $env:HIVEMIND_NODE
        if (Test-Path $Configured) { return $Configured }
        $Resolved = Get-Command $Configured -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($Resolved -and $Resolved.Source) { return $Resolved.Source }
    }
    foreach ($Name in @("node", "node.exe")) {
        $Found = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($Found -and $Found.Source) { return $Found.Source }
    }
    foreach ($Candidate in @(
        (Join-Path $HOME ".local\bin\node.cmd"),
        (Join-Path $HOME ".local\bin\node.exe")
    )) {
        if (Test-Path $Candidate) { return $Candidate }
    }
    return $null
}

$Node = Resolve-HiveNode
if (-not $Node) {
    [Console]::Error.WriteLine("[hive-switch] ERROR: Node.js is required to verify model tiers before switching. Install Node >= 22, then re-run install.ps1.")
    exit 1
}

$Forward = @($Backend, $Command)
if (-not [string]::IsNullOrWhiteSpace($Target)) { $Forward += $Target }

# Native stderr is written as an ErrorRecord under Windows PowerShell 5.1 when
# the preference is Stop. Continue temporarily so backend diagnostics stream
# cleanly and the native exit code survives for the caller.
$PreviousPreference = $ErrorActionPreference
$Code = 1
$ErrorActionPreference = "Continue"
try {
    & $Node @Forward
    $Code = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $PreviousPreference
}
exit $Code
