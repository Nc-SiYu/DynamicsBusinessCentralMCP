# Read-only listener identity probe. Output is a fixed projection, never a command line or environment.
$ErrorActionPreference = 'Stop'
function Test-RestoreRequestPort($request) {
    return ($request.kind -in @('gateway', 'web') -and
        ($request.port -is [long] -or $request.port -is [int]) -and
        $request.port -ge 1 -and $request.port -le 65535)
}
$stage = 'request'
try {
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    if (!(Test-RestoreRequestPort $request)) { throw 'Invalid port' }
    $stage = 'compile'
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
public static class GatewayRestoreArgs {
  [DllImport("shell32.dll", SetLastError=true)] static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string cmd, out int count);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadProcessMemory(IntPtr process, IntPtr address, [Out] byte[] data, UIntPtr length, out UIntPtr read);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsWow64Process2(IntPtr process, out ushort guest, out ushort native);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process, int kind, [Out] byte[] data, int length, out int returned);
  public static string[] Parse(string cmd) {
    int count; var ptr = CommandLineToArgvW(cmd, out count);
    if (ptr == IntPtr.Zero) throw new Exception("Cannot inspect process");
    try { var values = new string[count]; for (int i=0;i<count;i++) values[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(ptr, i*IntPtr.Size)); return values; }
    finally { LocalFree(ptr); }
  }
  // Exact known entry and argv. A persisted address makes only the final numeric
  // --port value redundant, matching native.run; never ignore any other argument.
  // Module entries additionally require their live CurrentDirectory below.
  public static int ArgumentVariant(string[] argv, string[] primary, string[][] alternatives) {
    return ArgumentVariant(argv, primary, alternatives, false);
  }
  public static int ArgumentVariant(string[] argv, string[] primary, string[][] alternatives, bool savedPortOverrides) {
    for (int variant=0; variant<=alternatives.Length; variant++) {
      var expected = variant==0 ? primary : alternatives[variant-1];
      if (argv.Length != expected.Length+1) continue;
      bool ignorePort=savedPortOverrides && expected.Length>=2 && expected[expected.Length-2]=="--port"
        && ValidPort(argv[argv.Length-1]);
      bool match=true;
      for (int i=0; i<expected.Length; i++) {
        if (ignorePort && i==expected.Length-1) continue;
        if (!String.Equals(argv[i+1], expected[i], StringComparison.OrdinalIgnoreCase)) { match=false; break; }
      }
      if (match) return variant;
    }
    return -1;
  }
  static bool ValidPort(string value) {
    if (String.IsNullOrEmpty(value) || value.Length>5) return false;
    foreach (char c in value) if (c<'0' || c>'9') return false;
    int port;
    return Int32.TryParse(value, out port) && port>=1 && port<=65535;
  }
  public static bool SameDirectory(string actual, string expected) {
    if (!Path.IsPathFullyQualified(actual) || !Path.IsPathFullyQualified(expected)) return false;
    return String.Equals(Path.GetFullPath(actual).TrimEnd('\\','/'), Path.GetFullPath(expected).TrimEnd('\\','/'), StringComparison.OrdinalIgnoreCase);
  }
  static byte[] ReadMetadata(IntPtr process, long address, int length) {
    if (address<=0 || length<1 || length>32766) throw new Exception("Metadata unavailable");
    var data=new byte[length]; UIntPtr read;
    if (!ReadProcessMemory(process, new IntPtr(address), data, new UIntPtr((uint)length), out read) || read.ToUInt64()!=(ulong)length) throw new Exception("Metadata unavailable");
    return data;
  }
  // Windows x64 layout, fail closed on other architectures or unavailable APIs.
  // Read exactly the PEB ProcessParameters pointer and CurrentDirectory descriptor/
  // string. Never read Environment, CommandLine, or the full parameter block.
  // Layout source: psutil/arch/windows/ntextapi.h (PEB / RTL_USER_PROCESS_PARAMETERS).
  public static string CurrentDirectory(int pid) {
    if (IntPtr.Size!=8) throw new Exception("Architecture unsupported");
    var process=OpenProcess(0x0410, false, pid); // QUERY_INFORMATION | VM_READ; no write/terminate rights.
    if (process==IntPtr.Zero) throw new Exception("Process unavailable");
    try {
      ushort guest,native;
      if (!IsWow64Process2(process,out guest,out native) || guest!=0 || native!=0x8664) throw new Exception("Architecture unsupported");
      var basic=new byte[48]; int returned;
      if (NtQueryInformationProcess(process,0,basic,basic.Length,out returned)<0 || returned!=basic.Length) throw new Exception("Metadata unavailable");
      long peb=BitConverter.ToInt64(basic,8);
      long parameters=BitConverter.ToInt64(ReadMetadata(process,peb+0x20,8),0);
      var descriptor=ReadMetadata(process,parameters+0x38,16);
      int length=BitConverter.ToUInt16(descriptor,0), maximum=BitConverter.ToUInt16(descriptor,2);
      if (length<2 || length%2!=0 || length>maximum || maximum>32766) throw new Exception("Metadata unavailable");
      string path=Encoding.Unicode.GetString(ReadMetadata(process,BitConverter.ToInt64(descriptor,8),length));
      if (!Path.IsPathFullyQualified(path)) throw new Exception("Metadata unavailable");
      foreach (char value in path) if (Char.IsControl(value)) throw new Exception("Metadata unavailable");
      return path;
    } finally { CloseHandle(process); }
  }
}
'@
    $stage = 'listeners'
    $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object LocalPort -eq $request.port)
    if ($listeners.Count -eq 0) { '{"state":"absent"}'; exit 0 }
    $processIds = @($listeners.OwningProcess | Sort-Object -Unique)
    if ($processIds.Count -ne 1) { '{"state":"foreign"}'; exit 0 }
    $stage = 'process'
    $candidate = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$processIds[0])
    $expectedExe = [IO.Path]::GetFullPath([string]$request.executable)
    if (!$candidate.ExecutablePath -or ![string]::Equals($candidate.ExecutablePath, $expectedExe, [StringComparison]::OrdinalIgnoreCase)) {
        '{"state":"foreign"}'; exit 0
    }
    $arguments = [GatewayRestoreArgs]::Parse($candidate.CommandLine)
    $alternatives = [string[][]]@($request.alternateArguments | ForEach-Object { ,([string[]]$_) })
    $variant = [GatewayRestoreArgs]::ArgumentVariant($arguments, [string[]]$request.arguments, $alternatives,
        ($request.kind -eq 'gateway' -and $request.savedPortOverrides -eq $true))
    if ($variant -lt 0) { '{"state":"foreign"}'; exit 0 }
    if ($variant -gt 0 -and ![GatewayRestoreArgs]::SameDirectory([GatewayRestoreArgs]::CurrentDirectory([int]$candidate.ProcessId), [string]$request.cwd)) {
        '{"state":"foreign"}'; exit 0
    }
    if ($request.kind -eq 'gateway' -and @($listeners | Where-Object LocalAddress -ne '127.0.0.1').Count -gt 0) {
        '{"state":"foreign"}'; exit 0
    }
    # Reject a PID replacement while the metadata was being read.
    $confirmed = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$candidate.ProcessId)
    if (!$confirmed -or $confirmed.CreationDate -ne $candidate.CreationDate -or $confirmed.ExecutablePath -ne $candidate.ExecutablePath) {
        '{"state":"unverified"}'; exit 0
    }
    @{state='owned';pid=[int]$candidate.ProcessId;started=$candidate.CreationDate.ToUniversalTime().ToString('o');entry=$(if ($variant -eq 0) {'primary'} else {'legacy'})} | ConvertTo-Json -Compress
} catch {
    $reason = switch ($stage) {
        'listeners' { 'LISTENER_QUERY_FAILED' }
        'process' { 'PROCESS_METADATA_FAILED' }
        'compile' { 'PROCESS_HELPER_COMPILE_FAILED' }
        default { 'PROCESS_PROBE_FAILED' }
    }
    @{state='unverified';reason=$reason} | ConvertTo-Json -Compress
}
