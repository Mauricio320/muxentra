# Instala o actualiza Muxentra desde el último release de GitHub.
#
#   irm https://raw.githubusercontent.com/Mauricio320/muxentra/main/install.ps1 | iex
#
# El mismo comando sirve para actualizar: siempre toma el release más reciente.
# Con $env:MUXENTRA_REPO se puede apuntar a otro repositorio sin editar el archivo.

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# Cambia esto por tu repositorio, o define $env:MUXENTRA_REPO antes de ejecutar.
$repo = if ($env:MUXENTRA_REPO) { $env:MUXENTRA_REPO } else { 'Mauricio320/muxentra' }

if ($repo -like 'Mauricio320/*') {
  throw "El instalador todavía apunta al repositorio de ejemplo '$repo'. Edita la variable `$repo en install.ps1 o define `$env:MUXENTRA_REPO con tu usuario y repositorio."
}

function Find-Editor {
  foreach ($name in 'code', 'code-insiders', 'cursor', 'windsurf') {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
  }
  throw "No encontré el comando 'code' en el PATH. Ábrelo en VS Code con Ctrl+Shift+P > 'Shell Command: Install code command in PATH' y vuelve a intentar."
}

$editor = Find-Editor
Write-Host "Editor: $editor"

$headers = @{ 'User-Agent' = 'muxentra-installer' }
$release = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest" -Headers $headers

$vsix = @($release.assets | Where-Object { $_.name -like '*.vsix' })
if ($vsix.Count -eq 0) { throw "El release $($release.tag_name) no tiene ningún .vsix adjunto." }

# Con paquetes por plataforma, elige el de esta máquina.
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
$asset = $vsix | Where-Object { $_.name -like "*win32-$arch*" } | Select-Object -First 1
if (-not $asset) { $asset = $vsix | Select-Object -First 1 }

# El nombre del asset viene de la API y acaba en una ruta: no se acepta que
# traiga separadores de directorio.
$name = [IO.Path]::GetFileName($asset.name)
if ([string]::IsNullOrWhiteSpace($name) -or $name -ne $asset.name -or $name -notlike '*.vsix') {
  throw "El release trae un asset con un nombre inesperado: $($asset.name)"
}

$dest = Join-Path $env:TEMP $name
Write-Host "Descargando $name ($([math]::Round($asset.size / 1MB, 1)) MB) de $($release.tag_name)..."
Invoke-WebRequest $asset.browser_download_url -OutFile $dest -UseBasicParsing

try {
  # GitHub publica el digest del asset. Si está, se comprueba: así un archivo
  # alterado en tránsito o un mirror manipulado no llega a instalarse.
  if ($asset.digest -and $asset.digest -match '^sha256:([0-9a-fA-F]{64})$') {
    $expected = $Matches[1]
    $actual = (Get-FileHash -Path $dest -Algorithm SHA256).Hash
    if ($actual -ne $expected) {
      throw "El archivo descargado no coincide con el publicado en el release (SHA256 $actual, esperado $expected). No se instala."
    }
    Write-Host "SHA256 verificado: $($actual.ToLower())"
  }
  else {
    Write-Warning "El release no publica el hash del asset; se instala sin verificar. SHA256 del archivo: $((Get-FileHash -Path $dest -Algorithm SHA256).Hash.ToLower())"
  }

  Write-Host 'Instalando...'
  & $editor --install-extension $dest --force
  if ($LASTEXITCODE -ne 0) { throw "La instalación falló con código $LASTEXITCODE." }
}
finally {
  Remove-Item $dest -Force -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host 'Listo. Recarga la ventana (Ctrl+Shift+P > Developer: Reload Window) y abre las terminales con Ctrl+Alt+T.'
