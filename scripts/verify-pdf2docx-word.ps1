param(
    [string]$Directory = (Join-Path $PSScriptRoot '../.cache/pdf2docx-public/after'),
    [string]$Manifest = (Join-Path $PSScriptRoot '../src/tests/__fixtures__/pdf2docx-public.json')
)

$ErrorActionPreference = 'Stop'
$qaDirectory = (Resolve-Path -LiteralPath $Directory).Path
$samples = @(Get-Content -LiteralPath $Manifest -Raw | ConvertFrom-Json)
if (-not $samples.Count) { throw 'The manifest must contain at least one PDF sample.' }
foreach ($sample in $samples) {
    if ($sample.id -notmatch '^[a-z0-9-]+$') { throw 'Invalid sample ID.' }
    $expected = if ($sample.pages) { @($sample.pages | Select-Object -Unique).Count } else { $sample.sourcePageCount }
    if (-not $expected -or $expected -lt 1) { throw ('Missing pages or sourcePageCount: ' + $sample.id) }
    # Validate all paths before starting Word.
    $null = Resolve-Path -LiteralPath (Join-Path $qaDirectory ($sample.id + '.docx'))
}
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
$results = @()
try {
    foreach ($sample in $samples) {
        $expected = if ($sample.pages) { @($sample.pages | Select-Object -Unique).Count } else { $sample.sourcePageCount }
        $path = (Resolve-Path -LiteralPath (Join-Path $qaDirectory ($sample.id + '.docx'))).Path
        # Work only with generated QA documents in our own hidden Word instance.
        $document = $word.Documents.Open($path, $false, $true)
        try {
            $document.ExportAsFixedFormat([IO.Path]::ChangeExtension($path, '.pdf'), 17)
            $count = $document.ComputeStatistics(2)
            $result = [pscustomobject]@{
                id = $sample.id
                sourcePages = @($sample.pages)
                expectedPages = $expected
                renderedPages = $count
                matches = ($count -eq $expected)
                wordVersion = $word.Version
                wordBuild = $word.Build
            }
            $results += $result
            Write-Output ($sample.id + ': ' + $count + ' pages (expected ' + $expected + ')')
        } finally {
            $document.Close(0)
        }
    }
} finally {
    $word.Quit()
}
$results | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $qaDirectory 'word-pagination.json') -Encoding utf8
if ($results.Where({ -not $_.matches }).Count) {
    throw 'Word pagination differs from the selected source pages. Inspect the rendered PDFs.'
}
