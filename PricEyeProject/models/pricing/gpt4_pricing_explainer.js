/**
 * Modèle GPT-4 pour l'explicabilité et les recommandations contextuelles
 * Utilise l'API OpenAI pour générer des recommandations de prix avec explications
 */

const { supabase } = require('../../config/supabase.js');
const OpenAI = require('openai');
require('dotenv').config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Récupère le contexte local (événements, météo, etc.) via recherche web
 */
async function getLocalContext(city, country, date) {
    // Pour l'instant, retourner un contexte vide
    // TODO: Intégrer avec Perplexity API ou une API d'événements
    return {
        events: [],
        weather: null,
        holidays: []
    };
}

/**
 * Génère une recommandation de prix avec GPT-4
 */
async function generatePriceRecommendationWithGPT4(property, features, demandForecast, otherModelPrices) {
    const propertyName = property.name || property.address || 'Propriété';
    const city = property.city || 'Inconnu';
    const country = property.country || 'Inconnu';
    const date = features.date;
    const basePrice = property.base_price || 0;
    
    // Récupérer le contexte local
    const localContext = await getLocalContext(city, country, date);
    
    // Construire le prompt pour GPT-4
    const prompt = `Tu es un expert en pricing dynamique pour les locations courtes durées (type Airbnb).

Propriété: ${propertyName}
Localisation: ${city}, ${country}
Caractéristiques: ${property.bedrooms || 0} chambres, ${property.property_type || 'N/A'}
Prix de base: ${basePrice}€
Date: ${date}

Données historiques:
- Taux d'occupation 7 jours: ${features.occupancy_rate_7d || 0}%
- Taux d'occupation 30 jours: ${features.occupancy_rate_30d || 0}%
- Score de demande 7 jours: ${features.demand_score_7d || 0}/100
- Score de demande 30 jours: ${features.demand_score_30d || 0}/100
- Jours depuis dernière réservation: ${features.days_since_last_booking !== null ? features.days_since_last_booking : 'N/A'}
- Jours jusqu'à prochaine réservation: ${features.days_until_next_booking !== null ? features.days_until_next_booking : 'N/A'}

Prévision de demande (Prophet):
- Score de demande prévu: ${demandForecast ? demandForecast.demand_score : 'N/A'}/100

Recommandations d'autres modèles:
- XGBoost: ${otherModelPrices.xgboost || 'N/A'}€
- Réseau de neurones: ${otherModelPrices.neuralNetwork || 'N/A'}€

Contexte local:
- Événements: ${localContext.events.length > 0 ? localContext.events.join(', ') : 'Aucun événement majeur connu'}
- Jours fériés: ${localContext.holidays.length > 0 ? localContext.holidays.join(', ') : 'Aucun'}

Ta tâche:
1. Analyser tous ces facteurs
2. Recommander un prix optimal pour cette date
3. Expliquer ta recommandation de manière claire et concise
4. Indiquer ta confiance dans cette recommandation (0-100)
5. Lister les facteurs clés ayant influencé ta décision

Réponds UNIQUEMENT en JSON avec cette structure:
{
  "recommended_price": nombre,
  "explanation": "texte explicatif en français",
  "confidence": nombre entre 0 et 100,
  "key_factors": {
    "demand": "low|medium|high",
    "occupancy": "low|medium|high",
    "seasonality": "low|medium|high",
    "events": ["facteur1", "facteur2"],
    "competition": "low|medium|high"
  }
}`;

    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                {
                    role: "system",
                    content: "Tu es un expert en pricing dynamique pour les locations courtes durées. Tu analyses les données historiques, la demande, les événements locaux et les recommandations de modèles ML pour suggérer des prix optimaux avec des explications claires."
                },
                {
                    role: "user",
                    content: prompt
                }
            ],
            response_format: { type: "json_object" },
            temperature: 0.7,
            max_tokens: 1000
        });
        
        const content = response.choices[0]?.message?.content;
        if (!content) {
            throw new Error('Réponse GPT-4 vide');
        }
        
        const result = JSON.parse(content);
        
        // Valider et normaliser le résultat
        return {
            price_gpt4: Math.max(0, parseFloat(result.recommended_price) || basePrice),
            explanation: result.explanation || 'Recommandation générée par GPT-4',
            confidence: Math.max(0, Math.min(100, parseFloat(result.confidence) || 50)),
            key_factors: result.key_factors || {}
        };
    } catch (error) {
        console.error(`Erreur GPT-4 pour ${propertyName} le ${date}:`, error.message);
        
        // Fallback: utiliser la moyenne des autres modèles ou le prix de base
        const fallbackPrice = otherModelPrices.xgboost || otherModelPrices.neuralNetwork || basePrice;
        
        return {
            price_gpt4: fallbackPrice,
            explanation: 'Recommandation par défaut (erreur API GPT-4)',
            confidence: 30,
            key_factors: {}
        };
    }
}

/**
 * Génère des recommandations GPT-4 pour une propriété
 */
async function generatePriceRecommendations(propertyId, startDate, endDate) {
    console.log(`[GPT-4] Génération de recommandations pour ${propertyId}`);
    
    // Récupérer la propriété
    const { data: property, error: propError } = await supabase
        .from('properties')
        .select('*')
        .eq('id', propertyId)
        .single();
    
    if (propError || !property) {
        throw new Error(`Propriété ${propertyId} non trouvée`);
    }
    
    // Récupérer les features
    const { data: features, error: featuresError } = await supabase
        .from('features_pricing_daily')
        .select('*')
        .eq('property_id', propertyId)
        .gte('date', startDate)
        .lte('date', endDate)
        .order('date', { ascending: true });
    
    if (featuresError) throw featuresError;
    
    if (!features || features.length === 0) {
        console.warn(`  ⚠ Aucune feature trouvée`);
        return [];
    }
    
    console.log(`  → ${features.length} date(s) à analyser`);
    
    // Récupérer les prévisions de demande (Prophet)
    const { data: demandForecasts, error: demandError } = await supabase
        .from('demand_forecasts')
        .select('*')
        .eq('city', property.city)
        .gte('forecast_date', startDate)
        .lte('forecast_date', endDate)
        .order('forecast_date', { ascending: true });
    
    if (demandError) {
        console.warn(`  ⚠ Erreur lors de la récupération des prévisions: ${demandError.message}`);
    }
    
    const demandForecastMap = new Map();
    (demandForecasts || []).forEach(f => {
        demandForecastMap.set(f.forecast_date, f);
    });
    
    // Récupérer les recommandations des autres modèles
    const { data: otherRecommendations, error: recError } = await supabase
        .from('pricing_recommendations')
        .select('price_xgboost, price_neural_network, date')
        .eq('property_id', propertyId)
        .gte('date', startDate)
        .lte('date', endDate);
    
    if (recError) {
        console.warn(`  ⚠ Erreur lors de la récupération des autres recommandations: ${recError.message}`);
    }
    
    const otherRecMap = new Map();
    (otherRecommendations || []).forEach(r => {
        otherRecMap.set(r.date, {
            xgboost: r.price_xgboost,
            neuralNetwork: r.price_neural_network
        });
    });
    
    // Générer les recommandations pour chaque date
    const recommendations = [];
    let processed = 0;
    
    for (const featureRow of features) {
        try {
            const demandForecast = demandForecastMap.get(featureRow.date) || null;
            const otherPrices = otherRecMap.get(featureRow.date) || { xgboost: null, neuralNetwork: null };
            
            // Appeler GPT-4 (avec un petit délai pour éviter rate limiting)
            if (processed > 0 && processed % 10 === 0) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            
            const gpt4Result = await generatePriceRecommendationWithGPT4(
                property,
                featureRow,
                demandForecast,
                { xgboost: otherPrices.xgboost, neuralNetwork: otherPrices.neuralNetwork }
            );
            
            recommendations.push({
                property_id: propertyId,
                date: featureRow.date,
                price_gpt4: gpt4Result.price_gpt4,
                explanation: gpt4Result.explanation,
                confidence: gpt4Result.confidence,
                key_factors: gpt4Result.key_factors
            });
            
            processed++;
            
            if (processed % 5 === 0) {
                console.log(`  → ${processed}/${features.length} dates traitées`);
            }
        } catch (error) {
            console.error(`  ✗ Erreur pour ${featureRow.date}:`, error.message);
        }
    }
    
    console.log(`  ✓ ${recommendations.length} recommandation(s) générée(s)`);
    
    return recommendations;
}

// Si le script est exécuté directement
if (require.main === module) {
    const args = process.argv.slice(2);
    
    let propertyId = null;
    let startDate = null;
    let endDate = null;
    
    args.forEach(arg => {
        if (arg.startsWith('--property-id=')) {
            propertyId = arg.split('=')[1];
        } else if (arg.startsWith('--start-date=')) {
            startDate = arg.split('=')[1];
        } else if (arg.startsWith('--end-date=')) {
            endDate = arg.split('=')[1];
        }
    });
    
    if (!propertyId) {
        console.error('--property-id est requis');
        process.exit(1);
    }
    
    if (!startDate || !endDate) {
        const today = new Date();
        startDate = startDate || today.toISOString().split('T')[0];
        const futureDate = new Date(today);
        futureDate.setDate(futureDate.getDate() + 90);
        endDate = endDate || futureDate.toISOString().split('T')[0];
    }
    
    generatePriceRecommendations(propertyId, startDate, endDate)
        .then(() => {
            console.log('\n✓ Recommandations GPT-4 générées avec succès');
            process.exit(0);
        })
        .catch(error => {
            console.error('\n✗ Erreur:', error);
            process.exit(1);
        });
}

module.exports = {
    generatePriceRecommendations,
    generatePriceRecommendationWithGPT4
};

