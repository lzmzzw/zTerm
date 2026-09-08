param(
  [Parameter(Mandatory, Position = 0)]
  [string] $TestExecutable,
  [Parameter(Position = 1, ValueFromRemainingArguments = $true)]
  [string[]] $TestArgs
)

$ErrorActionPreference = "Stop"
$manifestPath = "$TestExecutable.manifest"
$manifest = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*"/>
    </dependentAssembly>
  </dependency>
</assembly>
'@

[System.IO.File]::WriteAllText($manifestPath, $manifest, [System.Text.UTF8Encoding]::new($false))
& $TestExecutable @TestArgs
exit $LASTEXITCODE
