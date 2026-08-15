# utils.ps1
# Shared utility functions for PowerShell scripts

function Install-RequiredCommand {
    param(
        [string]$CommandName,
        [string]$WingetId
    )

    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
    
    if (-not (Get-Command $CommandName -ErrorAction SilentlyContinue)) {
        Write-Host "Tool '$CommandName' not found. Installing '$WingetId' via winget..."
        # Run winget install
        Start-Process winget -ArgumentList "install", "--id", $WingetId, "--silent", "--accept-source-agreements", "--accept-package-agreements" -NoNewWindow -Wait
        # Refresh environment path to check if it was added
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
        if (-not (Get-Command $CommandName -ErrorAction SilentlyContinue)) {
            throw "ERROR: '$CommandName' still not found after winget install. Please restart shell or install manually."
        }
    }
}
