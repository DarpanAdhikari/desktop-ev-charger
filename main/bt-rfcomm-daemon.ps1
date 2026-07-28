param(
    [Parameter(Mandatory = $true)]
    [string]$Address
)

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

# ─── Helper: Write JSON response to stdout ─────────────────────────────────────
function Write-Response($response) {
    $json = $response | ConvertTo-Json -Compress
    try {
        $stdout = [System.Console]::OpenStandardOutput()
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($json + "`n")
        $stdout.Write($bytes, 0, $bytes.Length)
        $stdout.Flush()
    } catch {
        # Fallback if direct console output fails
        Write-Output $json
    }
}

# ─── Load WinRT types ─────────────────────────────────────────────────────────
$winrtLoaded = $false
try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction Stop
    $null = [Windows.Devices.Bluetooth.BluetoothDevice, Windows.Devices.Bluetooth, ContentType = WindowsRuntime]
    $null = [Windows.Devices.Enumeration.DeviceInformation, Windows.Devices.Enumeration, ContentType = WindowsRuntime]
    $null = [Windows.Storage.Streams.DataWriter, Windows.Storage.Streams, ContentType = WindowsRuntime]
    $null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]
    $winrtLoaded = $true
} catch {
    Write-Response @{ id = 0; success = $false; event = 'error'; message = "Failed to load WinRT types: $($_.Exception.Message)" }
    exit 1
}

# ─── Connect to device ─────────────────────────────────────────────────────────
$device = $null
$socket = $null
$dataWriter = $null

try {
    $macUint64 = [System.UInt64]::Parse($Address.Replace(':', ''), [System.Globalization.NumberStyles]::HexNumber)
    $device = Await ([Windows.Devices.Bluetooth.BluetoothDevice]::FromBluetoothAddressAsync($macUint64))
    if (-not $device) {
        Write-Response @{ id = 0; success = $false; event = 'error'; message = "Device not found at $Address" }
        exit 1
    }

    $servicesResult = Await ($device.GetRfcommServicesAsync())
    if ($servicesResult.Services.Count -eq 0) {
        Write-Response @{ id = 0; success = $false; event = 'error'; message = "No RFCOMM services found on $Address" }
        exit 1
    }

    $service = $servicesResult.Services[0]
    $socket = Await ($service.OpenStreamSocketAsync())
    $dataWriter = [Windows.Storage.Streams.DataWriter]::new($socket.OutputStream)

    Write-Response @{ id = 0; success = $true; event = 'connected'; message = "Connected to $($device.Name)" }
} catch {
    $errMsg = $_.Exception.Message
    if ($errMsg -eq 'ScriptHalted' -or -not $errMsg) {
        $inner = $_.Exception.InnerException
        $errMsg = $inner ? $inner.Message : 'Unknown connection error'
    }
    if (-not $errMsg) { $errMsg = 'Connection failed: unknown error' }
    Write-Response @{ id = 0; success = $false; event = 'error'; message = "Connection failed: $errMsg" }
    if ($dataWriter) { try { $dataWriter.Dispose() } catch {} }
    if ($socket) { try { $socket.Close() } catch {} }
    exit 1
}

# ─── Command loop ──────────────────────────────────────────────────────────────
try {
    while ($true) {
        $line = [System.Console]::In.ReadLine()
        if ($null -eq $line) { break }

        $req = $null
        try { $req = $line | ConvertFrom-Json } catch { continue }

        $resp = @{ id = $req.id }

        switch ($req.command) {
            'send' {
                try {
                    $bytes = [System.Convert]::FromBase64String($req.data)
                    $dataWriter.WriteBytes($bytes)
                    Await ($dataWriter.StoreAsync())
                    $resp.success = $true
                    $resp.message = "Sent $($bytes.Length) bytes"
                } catch {
                    $resp.success = $false
                    $resp.error = "Send failed: $($_.Exception.Message)"
                }
            }

            'ping' {
                $resp.success = $true
            }

            'disconnect' {
                $resp.success = $true
                $resp.message = "Disconnected"
                Write-Response $resp
                break
            }

            default {
                $resp.success = $false
                $resp.error = "Unknown command: $($req.command)"
            }
        }

        Write-Response $resp

        if ($req.command -eq 'disconnect') {
            break
        }
    }
} catch {
    Write-Response @{ id = -1; success = $false; event = 'error'; message = "Daemon error: $($_.Exception.Message)" }
} finally {
    if ($dataWriter) { try { $dataWriter.Dispose() } catch {} }
    if ($socket) { try { $socket.Close() } catch {} }
    if ($dataWriter -or $socket) {
        Write-Response @{ id = -1; success = $true; event = 'disconnected'; message = 'Socket closed' }
    }
    exit 0
}
