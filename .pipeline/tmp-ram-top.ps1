$os = Get-CimInstance Win32_OperatingSystem
$totalGB = [math]::Round($os.TotalVisibleMemorySize/1MB,2)
$freeGB  = [math]::Round($os.FreePhysicalMemory/1MB,2)
$usedGB  = [math]::Round($totalGB - $freeGB,2)
$pct     = [math]::Round(($usedGB/$totalGB)*100,1)
Write-Output "RAM_TOTAL_GB=$totalGB RAM_USED_GB=$usedGB RAM_FREE_GB=$freeGB RAM_PCT=$pct"
Write-Output ""
Write-Output "TOP-15 por proceso INDIVIDUAL (RAM MB):"
Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 15 |
    Select-Object ProcessName, Id, @{N='RAM_MB';E={[math]::Round($_.WorkingSet64/1MB,1)}} |
    Format-Table -AutoSize | Out-String -Width 200
Write-Output ""
Write-Output "TOP-15 AGRUPADO por nombre (RAM MB):"
Get-Process | Group-Object ProcessName | ForEach-Object {
    [PSCustomObject]@{
        Name    = $_.Name
        Count   = $_.Count
        TotalMB = [math]::Round((($_.Group | Measure-Object WorkingSet64 -Sum).Sum)/1MB,1)
    }
} | Sort-Object TotalMB -Descending | Select-Object -First 15 |
    Format-Table -AutoSize | Out-String -Width 200
