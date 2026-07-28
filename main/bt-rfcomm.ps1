param(
    [Parameter(Mandatory = $true)]
    [string]$Command,
    [string]$Address,
    [string]$Data,
    [string]$DeviceName,
    [string]$DataFilePath
)

# ─── Helper: Load WinRT types ──────────────────────────────────────────────────
$winrtLoaded = $false
try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction Stop
    Add-Type -AssemblyName System.Runtime.WindowsRuntime.UI.Xaml -ErrorAction SilentlyContinue
    $null = [Windows.Devices.Bluetooth.BluetoothDevice, Windows.Devices.Bluetooth, ContentType = WindowsRuntime]
    $null = [Windows.Devices.Enumeration.DeviceInformation, Windows.Devices.Enumeration, ContentType = WindowsRuntime]
    $null = [Windows.Storage.Streams.DataWriter, Windows.Storage.Streams, ContentType = WindowsRuntime]
    $null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]
    $winrtLoaded = $true
} catch {
    $winrtLoaded = $false
}

# ─── Helper: Await an IAsyncOperation ──────────────────────────────────────────
function Await($asyncOp) {
    try {
        $asTask = [System.Runtime.InteropServices.WindowsRuntime.AsyncInfo]::AsTask($asyncOp)
        $asTask.Wait() | Out-Null
        if ($asTask.Exception) {
            $inner = $asTask.Exception.InnerException
            throw ($inner ? $inner.Message : "Task faulted")
        }
        return $asTask.Result
    } catch {
        $inner = $_.Exception.InnerException
        throw ($inner ? $inner : $_.Exception.Message)
    }
}

# ─── Scan ───────────────────────────────────────────────────────────────────────
function Scan-Devices {
    if (-not $winrtLoaded) { return @() }
    $devices = @()
    try {
        $btSelector = [Windows.Devices.Bluetooth.BluetoothDevice]::GetDeviceSelector()
        $btDevices = Await ([Windows.Devices.Enumeration.DeviceInformation]::FindAllAsync($btSelector))
        foreach ($info in $btDevices) {
            $devices += @{
                name       = $info.Name
                macAddress = $info.Id -replace '.*#(.*)#.*', '$1'
                id         = $info.Id
            }
        }
    } catch {
        return @()
    }
    return $devices
}

# ─── Pair ────────────────────────────────────────────────────────────────────────
function Pair-Device {
    param([string]$Address)
    try {
        $device = Await ([Windows.Devices.Bluetooth.BluetoothDevice]::FromBluetoothAddressAsync([System.UInt64]::Parse($Address.Replace(':', ''), [System.Globalization.NumberStyles]::HexNumber)))
        $pairResult = Await ($device.Pairing.PairAsync())
        if ($pairResult.Status -eq 'Paired') {
            return @{ success = $true; message = "Paired with $($device.Name)" }
        }
        return @{ success = $false; error = "Pairing failed: $($pairResult.Status)" }
    } catch {
        return @{ success = $false; error = $_.Exception.Message }
    }
}

# ─── Connect ────────────────────────────────────────────────────────────────────
function Connect-Device {
    param([string]$Address)
    try {
        $device = Await ([Windows.Devices.Bluetooth.BluetoothDevice]::FromBluetoothAddressAsync([System.UInt64]::Parse($Address.Replace(':', ''), [System.Globalization.NumberStyles]::HexNumber)))
        $services = Await ($device.GetRfcommServicesAsync())
        if ($services.Services.Count -gt 0) {
            $service = $services.Services[0]
            $streamSocket = Await ($service.OpenStreamSocketAsync())
            return @{ success = $true; message = "Connected to $($device.Name)" }
        }
        return @{ success = $false; error = "No RFCOMM services found on $Address" }
    } catch {
        return @{ success = $false; error = $_.Exception.Message }
    }
}

# ─── Send Data ──────────────────────────────────────────────────────────────────
function Send-Data {
    param([string]$Address, [string]$DataBase64, [string]$DataFilePath)
    try {
        if ($DataFilePath -and (Test-Path $DataFilePath)) {
            $DataBase64 = Get-Content -Path $DataFilePath -Raw -Encoding ASCII
        }
        if (-not $DataBase64) {
            return @{ success = $false; error = "No data provided" }
        }
        $device = Await ([Windows.Devices.Bluetooth.BluetoothDevice]::FromBluetoothAddressAsync([System.UInt64]::Parse($Address.Replace(':', ''), [System.Globalization.NumberStyles]::HexNumber)))
        $services = Await ($device.GetRfcommServicesAsync())
        if ($services.Services.Count -eq 0) {
            return @{ success = $false; error = "No RFCOMM services found on $Address" }
        }
        $service = $services.Services[0]
        $streamSocket = Await ($service.OpenStreamSocketAsync())
        $dataWriter = [Windows.Storage.Streams.DataWriter]::new($streamSocket.OutputStream)
        $bytes = [System.Convert]::FromBase64String($DataBase64)
        $dataWriter.WriteBytes($bytes)
        Await ($dataWriter.StoreAsync())
        return @{ success = $true; message = "Sent $($bytes.Length) bytes" }
    } catch {
        return @{ success = $false; error = $_.Exception.Message }
    }
}

# ─── Pair and Connect ────────────────────────────────────────────────────────────
function PairAndConnect {
    param([string]$Address)
    try {
        $device = Await ([Windows.Devices.Bluetooth.BluetoothDevice]::FromBluetoothAddressAsync([System.UInt64]::Parse($Address.Replace(':', ''), [System.Globalization.NumberStyles]::HexNumber)))
        
        $pairResult = Await ($device.Pairing.PairAsync())
        $pairStatus = $pairResult.Status
        if ($pairStatus -ne 'Paired') {
            return @{ success = $false; error = "Pairing failed: $pairStatus" }
        }
        
        $services = Await ($device.GetRfcommServicesAsync())
        if ($services.Services.Count -gt 0) {
            $service = $services.Services[0]
            $streamSocket = Await ($service.OpenStreamSocketAsync())
            return @{ success = $true; message = "Paired and connected to $($device.Name)" }
        }
        return @{ success = $false; error = "No RFCOMM services found on $Address" }
    } catch {
        return @{ success = $false; error = $_.Exception.Message }
    }
}

# ─── Diagnose ────────────────────────────────────────────────────────────────────
function Diagnose-Device {
    param([string]$Name)
    $results = @()
    
    $results += @{ step = "WinRT Loaded"; success = $winrtLoaded; detail = if ($winrtLoaded) { "WinRT types loaded successfully" } else { "WinRT types failed to load" } }
    
    try {
        $scanResult = Scan-Devices
        $targetDevice = $scanResult | Where-Object { $_.name -like "*$Name*" }
        if ($targetDevice) {
            $results += @{ step = "Scan"; success = $true; detail = "Found $($targetDevice.name) at $($targetDevice.macAddress)" }
            $macAddress = $targetDevice.macAddress
            
            try {
                $pairResult = Pair-Device -Address $macAddress
                $results += @{ step = "Pair"; success = $pairResult.success; detail = if ($pairResult.success) { "Paired successfully" } else { "Pairing failed: $($pairResult.error)" } }
            } catch {
                $results += @{ step = "Pair"; success = $false; detail = "Pairing exception: $($_.Exception.Message)" }
            }
            
            try {
                $connectResult = Connect-Device -Address $macAddress
                $results += @{ step = "Connect"; success = $connectResult.success; detail = if ($connectResult.success) { "Connected successfully" } else { "Connection failed: $($connectResult.error)" } }
            } catch {
                $results += @{ step = "Connect"; success = $false; detail = "Connection exception: $($_.Exception.Message)" }
            }
        } else {
            $results += @{ step = "Scan"; success = $false; detail = "No device found matching name '$Name'" }
        }
    } catch {
        $results += @{ step = "Scan"; success = $false; detail = "Scan exception: $($_.Exception.Message)" }
    }
    
    return $results
}

# ─── Main ───────────────────────────────────────────────────────────────────────
switch ($Command) {
    'scan' {
        $result = Scan-Devices
        return ($result | ConvertTo-Json -Compress)
    }
    'pair' {
        $result = Pair-Device -Address $Address
        return ($result | ConvertTo-Json -Compress)
    }
    'connect' {
        $result = Connect-Device -Address $Address
        return ($result | ConvertTo-Json -Compress)
    }
    'send' {
        $result = Send-Data -Address $Address -DataBase64 $Data -DataFilePath $DataFilePath
        return ($result | ConvertTo-Json -Compress)
    }
    'pair-and-connect' {
        $result = PairAndConnect -Address $Address
        return ($result | ConvertTo-Json -Compress)
    }
    'diagnose' {
        $result = Diagnose-Device -Name $DeviceName
        return ($result | ConvertTo-Json -Compress)
    }
    default {
        return (@{ success = $false; error = "Unknown command: $Command" } | ConvertTo-Json -Compress)
    }
}
