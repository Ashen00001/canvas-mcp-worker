param([Parameter(Mandatory)][string]$Name, [string]$Hint = "")
Set-Location $PSScriptRoot
$cfg = Get-Content (Join-Path $PSScriptRoot 'wrangler.jsonc') -Raw -ErrorAction SilentlyContinue
$CanvasBase = if ($cfg -match '"CANVAS_BASE_URL"\s*:\s*"([^"]+)"') { $Matches[1] } else { '' }
if ($Name -eq 'CANVAS_API_TOKEN' -and -not $CanvasBase) { Write-Host 'Run setup first: wrangler.jsonc has no CANVAS_BASE_URL.' -ForegroundColor Red; exit 1 }
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$f = New-Object System.Windows.Forms.Form
$f.Text = "Set Worker secret: $Name"
$f.TopMost = $true
$f.StartPosition = 'CenterScreen'
$f.FormBorderStyle = 'FixedDialog'
$f.MaximizeBox = $false
$f.ClientSize = New-Object System.Drawing.Size(460, 150)
$f.Font = New-Object System.Drawing.Font('Segoe UI', 10)

$l = New-Object System.Windows.Forms.Label
$l.SetBounds(14, 10, 432, 44)
$l.Text = "Paste $Name below and click Save.`n$Hint"
$f.Controls.Add($l)

$t = New-Object System.Windows.Forms.TextBox
$t.SetBounds(14, 60, 432, 28)
$t.UseSystemPasswordChar = $true
$f.Controls.Add($t)

$s = New-Object System.Windows.Forms.Label
$s.SetBounds(14, 100, 326, 44)
$f.Controls.Add($s)

$b = New-Object System.Windows.Forms.Button
$b.Text = 'Save'
$b.SetBounds(346, 106, 100, 32)
$f.AcceptButton = $b
$f.Controls.Add($b)

$b.Add_Click({
	$v = ($t.Text -replace '^\s*Bearer\s+', '').Trim()
	if (-not $v) { $s.Text = 'Empty - paste the value first.'; return }
	$b.Enabled = $false
	if ($Name -eq 'CANVAS_API_TOKEN') {
		$s.ForeColor = 'Black'; $s.Text = "Checking with Canvas (length $($v.Length))..."; $f.Refresh()
		try {
			[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
			$r = Invoke-WebRequest -UseBasicParsing -Uri ($CanvasBase.TrimEnd('/') + '/api/v1/users/self') -Headers @{ Authorization = "Bearer $v" } -TimeoutSec 20
			$code = [int]$r.StatusCode
		} catch { $code = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { -1 } }
		if ($code -ne 200) {
			$s.ForeColor = 'Red'
			$s.Text = if ($code -eq 401) { "Canvas rejected it (401). Length $($v.Length), expect ~70 with a ~" } else { "Canvas check failed ($code)." }
			$b.Enabled = $true; return
		}
		$s.ForeColor = 'Green'; $s.Text = 'Canvas says valid. Saving...'; $f.Refresh()
	}
	$s.Text = 'Saving...'; $f.Refresh()
	$v | npx wrangler secret put $Name *> $null
	$code = $LASTEXITCODE
	$t.Text = ''; $v = $null
	if ($code -eq 0) { $s.ForeColor = 'Green'; $s.Text = "$Name set. Closing..."; $f.Refresh(); Start-Sleep 2; $f.Close() }
	else { $s.ForeColor = 'Red'; $s.Text = "Failed (exit $code). Try again."; $b.Enabled = $true }
})
$f.Add_Shown({ $f.Activate(); $t.Focus() })
[void]$f.ShowDialog()
