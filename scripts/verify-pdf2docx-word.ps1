param([string]$Directory = (Join-Path $PSScriptRoot '../.cache/pdf2docx-public/after'))

$ErrorActionPreference = 'Stop'
$qaDirectory = (Resolve-Path -LiteralPath $Directory).Path
$samples = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../src/tests/__fixtures__/pdf2docx-public.json') -Raw | ConvertFrom-Json
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
$results = @()
try {
    foreach ($sample in $samples) {
        $path = (Resolve-Path -LiteralPath (Join-Path $qaDirectory ($sample.id + '.docx'))).Path
        # Work only with generated QA documents in our own hidden Word instance.
        $document = $word.Documents.Open($path, $false, $true)
        try {
            $document.ExportAsFixedFormat([IO.Path]::ChangeExtension($path, '.pdf'), 17)
            $count = $document.ComputeStatistics(2)
            $result = [pscustomobject]@{
                id = $sample.id
                sourcePages = @($sample.pages)
                expectedPages = $sample.pages.Count
                renderedPages = $count
                matches = ($count -eq $sample.pages.Count)
                wordVersion = $word.Version
                wordBuild = $word.Build
            }
            $results += $result
            Write-Output ($sample.id + ': ' + $count + ' pages (expected ' + $sample.pages.Count + ')')
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
