#!/bin/bash

# Script de test API hébergée pour Linux/Mac
# Usage: ./test_api_hebergee.sh

# Configuration
API_URL="${API_URL:-}"
TOKEN="${API_TOKEN:-}"

if [ -z "$API_URL" ]; then
    read -p "Entrez l'URL de votre API (ex: https://priceye.onrender.com): " API_URL
fi

if [ -z "$TOKEN" ]; then
    read -p "Entrez votre token d'authentification: " TOKEN
fi

if [ -z "$API_URL" ] || [ -z "$TOKEN" ]; then
    echo "❌ Erreur: API_URL et TOKEN sont requis"
    exit 1
fi

echo "🧪 Démarrage des tests API..."
echo "API URL: $API_URL"
echo ""

# Compteurs
SUCCESS_COUNT=0
FAIL_COUNT=0

# Fonction helper
test_endpoint() {
    local method=$1
    local endpoint=$2
    local body=$3
    local description=$4
    
    echo "🔍 Test: $description"
    
    if [ -n "$body" ]; then
        response=$(curl -s -w "\n%{http_code}" -X "$method" \
            -H "Authorization: Bearer $TOKEN" \
            -H "Content-Type: application/json" \
            -d "$body" \
            "$API_URL$endpoint" 2>&1)
    else
        response=$(curl -s -w "\n%{http_code}" -X "$method" \
            -H "Authorization: Bearer $TOKEN" \
            "$API_URL$endpoint" 2>&1)
    fi
    
    http_code=$(echo "$response" | tail -n1)
    body_response=$(echo "$response" | sed '$d')
    
    if [ "$http_code" -eq 200 ] || [ "$http_code" -eq 201 ]; then
        echo "  ✅ Succès (HTTP $http_code)"
        if [ -n "$body_response" ]; then
            echo "$body_response" | jq '.' 2>/dev/null || echo "  $body_response"
        fi
        SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
        return 0
    else
        echo "  ❌ Erreur (HTTP $http_code)"
        echo "  Détails: $body_response"
        FAIL_COUNT=$((FAIL_COUNT + 1))
        return 1
    fi
    echo ""
}

# Test 1: Statut du pipeline
test_endpoint "GET" "/api/market-data/status" "" "Statut du pipeline"

# Test 2: Collecte manuelle
TODAY=$(date +%Y-%m-%d)
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS
    FUTURE_DATE=$(date -v+14d +%Y-%m-%d)
else
    # Linux
    FUTURE_DATE=$(date -d "+14 days" +%Y-%m-%d)
fi

COLLECT_BODY=$(cat <<EOF
{
  "countries": ["FR"],
  "cities": ["Paris"],
  "dateRange": {
    "startDate": "$TODAY",
    "endDate": "$FUTURE_DATE"
  }
}
EOF
)
test_endpoint "POST" "/api/market-data/collect" "$COLLECT_BODY" "Collecte manuelle (Paris)"

# Attendre que la collecte se termine
echo "⏳ Attente de 15 secondes pour la collecte..."
sleep 15

# Test 3: Enrichissement
ENRICH_BODY=$(cat <<EOF
{
  "dateRange": {
    "startDate": "$TODAY",
    "endDate": "$TODAY"
  }
}
EOF
)
test_endpoint "POST" "/api/market-data/enrich" "$ENRICH_BODY" "Enrichissement manuel"

# Attendre que l'enrichissement se termine
echo "⏳ Attente de 20 secondes pour l'enrichissement..."
sleep 20

# Test 4: Construction des features
FEATURES_BODY=$(cat <<EOF
{
  "cities": [{"country": "FR", "city": "Paris"}],
  "dateRange": {
    "startDate": "$TODAY",
    "endDate": "$TODAY"
  },
  "updatePricing": true
}
EOF
)
test_endpoint "POST" "/api/market-data/build-features" "$FEATURES_BODY" "Construction des features"

# Attendre un peu
echo "⏳ Attente de 5 secondes..."
sleep 5

# Test 5: Récupérer les features
test_endpoint "GET" "/api/market-data/features?city=Paris&country=FR&date=$TODAY" "" "Récupérer les features (Paris)"

# Test 6: Récupérer les prix concurrents
test_endpoint "GET" "/api/market-data/competitor-prices?city=Paris&country=FR&date=$TODAY" "" "Récupérer les prix concurrents (Paris)"

# Résumé
echo ""
echo "============================================================"
echo "RÉSUMÉ DES TESTS"
echo "============================================================"
echo "✅ Succès: $SUCCESS_COUNT"
echo "❌ Échecs: $FAIL_COUNT"
echo ""

if [ $FAIL_COUNT -eq 0 ]; then
    echo "🎉 Tous les tests ont réussi !"
    exit 0
else
    echo "⚠️ Certains tests ont échoué. Vérifiez les erreurs ci-dessus."
    exit 1
fi

