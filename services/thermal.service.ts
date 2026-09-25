/**
 * CPU Temperature & Thermal Protection Service
 *
 * Provides real-time CPU temperature readings across Windows, Linux, and macOS.
 * When running in desktop mode or when thermal protection is enabled, the tool
 * can rest and cool down when CPU temperature exceeds safe thresholds (e.g. 80°C+).
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import util from 'node:util';

const execFileAsync = util.promisify(execFile);

let cachedTemp: number | null = null;
let lastTempCheck = 0;
const CACHE_TTL_MS = 3000; // Cache temperature for 3 seconds to prevent sub-process thrashing

/**
 * Returns true if the application is running in desktop mode
 * (e.g. launched via Electron, desktop launcher script, or explicit environment variable).
 */
export function isDesktopMode(): boolean {
  return (
    process.env.IS_DESKTOP === '1' ||
    process.env.DESKTOP_APP === 'true' ||
    process.env.ELECTRON_RUN_AS_NODE === '1' ||
    Boolean(process.versions?.electron)
  );
}

/**
 * Windows PowerShell command to query thermal zones and hardware sensors.
 * Returns the highest valid temperature in Celsius, or 'UNKNOWN'.
 */
const WIN_THERMAL_SCRIPT = `
$temps = @()

# 1. Win32_PerfFormattedData_Counters_ThermalZoneInformation
try {
  $tz = Get-CimInstance -Namespace root/cimv2 -ClassName Win32_PerfFormattedData_Counters_ThermalZoneInformation -ErrorAction SilentlyContinue
  foreach ($z in $tz) {
    if ($z.HighPrecisionTemperature -and $z.HighPrecisionTemperature -gt 2732) {
      $temps += [math]::Round(($z.HighPrecisionTemperature / 10.0) - 273.15, 1)
    } elseif ($z.Temperature -and $z.Temperature -gt 273) {
      $temps += [math]::Round($z.Temperature - 273.15, 1)
    }
  }
} catch {}

# 2. MSAcpi_ThermalZoneTemperature (root/wmi)
if ($temps.Count -eq 0) {
  try {
    $acpi = Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction SilentlyContinue
    foreach ($a in $acpi) {
      if ($a.CurrentTemperature -and $a.CurrentTemperature -gt 2732) {
        $temps += [math]::Round(($a.CurrentTemperature / 10.0) - 273.15, 1)
      }
    }
  } catch {}
}

# 3. LibreHardwareMonitor / OpenHardwareMonitor
if ($temps.Count -eq 0) {
  try {
    $lhm = Get-CimInstance -Namespace root/LibreHardwareMonitor -ClassName Sensor -ErrorAction SilentlyContinue | Where-Object { $_.SensorType -eq 'Temperature' -and $_.Name -like '*CPU*' }
    foreach ($s in $lhm) {
      if ($s.Value -and $s.Value -gt 0) {
        $temps += [math]::Round($s.Value, 1)
      }
    }
  } catch {}
}

if ($temps.Count -gt 0) {
  ($temps | Measure-Object -Maximum).Maximum
} else {
  "UNKNOWN"
}
`;

async function readWindowsTemp(): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', WIN_THERMAL_SCRIPT],
      { timeout: 3500 },
    );
    const trimmed = stdout.trim();
    if (trimmed && trimmed !== 'UNKNOWN') {
      const val = parseFloat(trimmed);
      if (!isNaN(val) && val > 0 && val < 130) {
        return Math.round(val * 10) / 10;
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function readLinuxTemp(): Promise<number | null> {
  try {
    const zones = ['thermal_zone0', 'thermal_zone1', 'thermal_zone2'];
    let maxTemp = 0;
    for (const zone of zones) {
      try {
        const raw = await fs.readFile(`/sys/class/thermal/${zone}/temp`, 'utf8');
        const mC = parseInt(raw.trim(), 10);
        if (!isNaN(mC) && mC > 0) {
          const c = mC > 1000 ? mC / 1000 : mC;
          if (c > maxTemp) maxTemp = c;
        }
      } catch {
        // zone not readable, continue
      }
    }
    return maxTemp > 0 ? Math.round(maxTemp * 10) / 10 : null;
  } catch {
    return null;
  }
}

async function readMacTemp(): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync('osx-cpu-temp', [], { timeout: 2000 });
    const match = stdout.match(/([0-9.]+)/);
    if (match) {
      const val = parseFloat(match[1]);
      if (!isNaN(val) && val > 0 && val < 130) {
        return Math.round(val * 10) / 10;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Reads the current CPU temperature in Celsius.
 * Returns null if the temperature cannot be determined on this system.
 */
export async function getCpuTemperature(force = false): Promise<number | null> {
  const now = Date.now();
  if (!force && cachedTemp !== null && now - lastTempCheck < CACHE_TTL_MS) {
    return cachedTemp;
  }

  let temp: number | null = null;
  const platform = os.platform();

  if (platform === 'win32') {
    temp = await readWindowsTemp();
  } else if (platform === 'linux') {
    temp = await readLinuxTemp();
  } else if (platform === 'darwin') {
    temp = await readMacTemp();
  }

  cachedTemp = temp;
  lastTempCheck = now;
  return temp;
}
