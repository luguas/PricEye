# Script de test API hébergée pour Windows PowerShell
# Usage: .\test_api_hebergee.ps1

# Configuration
$API_URL = if ($env:API_URL) { $env:API_URL } else { Read-Host "Entrez l'URL de votre API (ex: https://priceye.onrender.com)" }
$TOKEN = if ($env:API_TOKEN) { $env:API_TOKEN } else { Read-Host "Entrez votre token d'authentification" }

if (-not $API_URL -or -not $TOKEN) {
    Write-Host "❌ Erreur: API_URL et TOKEN sont requis" -ForegroundColor Red
    exit 1
}

Write-Host "🧪 Démarrage des tests API..." -ForegroundColor Cyan
Write-Host "API URL: $API_URL" -ForegroundColor Gray
Write-Host ""

# Compteur de succès/échecs
$script:successCount = 0
$script:failCount = 0

# Fonction helper
function Test-Endpoint {
    param(
        [string]$Method,
        [string]$Endpoint,
        [object]$Body = $null,
        [string]$Description
    )
    
    Write-Host "🔍 Test: $Description" -ForegroundColor Yellow
    
    $headers = @{
        "Authorization" = "Bearer $TOKEN"
        "Content-Type" = "application/json"
    }
    
    try {
        $uri = "$API_URL$Endpoint"
        
        if ($Body) {
            $jsonBody = $Body | ConvertTo-Json -Depth 10 -Compress
            $response = Invoke-RestMethod -Uri $uri -Method $Method -Headers $headers -Body $jsonBody -ErrorAction Stop
        } else {
            $response = Invoke-RestMethod -Uri $uri -Method $Method -Headers $headers -ErrorAction Stop
        }
        
        Write-Host "  ✅ Succès" -ForegroundColor Green
        if ($response) {
            $responseJson = $response | ConvertTo-Json -Depth 3
            Write-Host "  Réponse: $responseJson" -ForegroundColor Gray
        }
        $script:successCount++
        return $true
    } catch {
        Write-Host "  ❌ Erreur: $($_.Exception.Message)" -ForegroundColor Red
        if ($_.Exception.Response) {
            try {
                $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
                $responseBody = $reader.ReadToEnd()
                Write-Host "  Détails: $responseBody" -ForegroundColor Red
            } catch {
                # Ignorer si on ne peut pas lire la réponse
            }
        }
        $script:failCount++
        return $false
    }
    Write-Host ""
}

# Test 1: Statut du pipeline
Test-Endpoint -Method "GET" -Endpoint "/api/market-data/status" -Description "Statut du pipeline"

# Test 2: Collecte manuelle (pour Paris)
$today = (Get-Date).ToString("yyyy-MM-dd")
$futureDate = (Get-Date).AddDays(14).ToString("yyyy-MM-dd")
$collectBody = @{
    countries = @("FR")
    cities = @("Paris")
    dateRange = @{
        startDate = $today
        endDate = $futureDate
    }
}
Test-Endpoint -Method "POST" -Endpoint "/api/market-data/collect" -Body $collectBody -Description "Collecte manuelle (Paris)"

# Attendre un peu que la collecte se termine
Write-Host "⏳ Attente de 15 secondes pour la collecte..." -ForegroundColor Yellow
Start-Sleep -Seconds 15

# Test 3: Enrichissement manuel
$enrichBody = @{
    dateRange = @{
        startDate = $today
        endDate = $today
    }
}
Test-Endpoint -Method "POST" -Endpoint "/api/market-data/enrich" -Body $enrichBody -Description "Enrichissement manuel"

# Attendre un peu que l'enrichissement se termine
Write-Host "⏳ Attente de 20 secondes pour l'enrichissement..." -ForegroundColor Yellow
Start-Sleep -Seconds 20

# Test 4: Construction des features
$featuresBody = @{
    cities = @(@{
        country = "FR"
        city = "Paris"
    })
    dateRange = @{
        startDate = $today
        endDate = $today
    }
    updatePricing = $true
}
Test-Endpoint -Method "POST" -Endpoint "/api/market-data/build-features" -Body $featuresBody -Description "Construction des features"

# Attendre un peu
Write-Host "⏳ Attente de 5 secondes..." -ForegroundColor Yellow
Start-Sleep -Seconds 5

# Test 5: Récupérer les features
Test-Endpoint -Method "GET" -Endpoint "/api/market-data/features?city=Paris&country=FR&date=$today" -Description "Récupérer les features (Paris)"

# Test 6: Récupérer les prix concurrents
Test-Endpoint -Method "GET" -Endpoint "/api/market-data/competitor-prices?city=Paris&country=FR&date=$today" -Description "Récupérer les prix concurrents (Paris)"

# Résumé
Write-Host ""
Write-Host "=" * 60 -ForegroundColor Cyan
Write-Host "RÉSUMÉ DES TESTS" -ForegroundColor Cyan
Write-Host "=" * 60 -ForegroundColor Cyan
Write-Host "✅ Succès: $script:successCount" -ForegroundColor Green
Write-Host "❌ Échecs: $script:failCount" -ForegroundColor $(if ($script:failCount -eq 0) { "Green" } else { "Red" })
Write-Host ""

if ($script:failCount -eq 0) {
    Write-Host "🎉 Tous les tests ont réussi !" -ForegroundColor Green
    exit 0
} else {
    Write-Host "⚠️ Certains tests ont échoué. Vérifiez les erreurs ci-dessus." -ForegroundColor Yellow
    exit 1
}

