import React, { useState, useEffect, useCallback } from 'react';
import { getAIQuota } from '../services/api.js';

const AIQuotaIndicator = ({ token, isCollapsed = false, onQuotaUpdate }) => {
  const [quota, setQuota] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  // Récupérer le token depuis localStorage si non fourni
  const getAuthToken = useCallback(() => {
    if (token) return token;
    if (typeof window !== 'undefined') {
      return localStorage.getItem('authToken');
    }
    return null;
  }, [token]);

  const fetchQuota = useCallback(async () => {
    const authToken = getAuthToken();
    if (!authToken) {
      setIsLoading(false);
      return;
    }

    try {
      setIsLoading(true);
      setError(null);
      const quotaData = await getAIQuota(authToken);
      setQuota(quotaData);
      
      // Notifier le parent si une fonction de callback est fournie
      if (onQuotaUpdate) {
        onQuotaUpdate(quotaData);
      }
    } catch (err) {
      console.error('[AI Quota] Erreur lors de la récupération du quota:', err);
      setError(err);
      // En cas d'erreur, ne pas bloquer l'affichage
      setQuota(null);
    } finally {
      setIsLoading(false);
    }
  }, [getAuthToken, onQuotaUpdate]);

  // Charger le quota au montage et après chaque appel IA
  useEffect(() => {
    fetchQuota();
    
    // Rafraîchir le quota toutes les 30 secondes
    const interval = setInterval(() => {
      fetchQuota();
    }, 30000);

    // Écouter les événements personnalisés pour rafraîchir après un appel IA
    const handleAIUsage = () => {
      // Délai court pour laisser le temps au backend de mettre à jour
      setTimeout(() => {
        fetchQuota();
      }, 1000);
    };

    window.addEventListener('aiCallCompleted', handleAIUsage);
    window.addEventListener('aiCallFailed', handleAIUsage);

    return () => {
      clearInterval(interval);
      window.removeEventListener('aiCallCompleted', handleAIUsage);
      window.removeEventListener('aiCallFailed', handleAIUsage);
    };
  }, [fetchQuota]);

  // Ne rien afficher si pas de token ou en chargement initial
  const authToken = getAuthToken();
  if (!authToken || isLoading) {
    return null;
  }

  // Ne rien afficher si erreur ou pas de données
  if (error || !quota) {
    return null;
  }

  const { callsToday = 0, maxCalls = 10, remaining = 0, resetAt } = quota;
  const usagePercentage = maxCalls > 0 ? (callsToday / maxCalls) * 100 : 0;

  // Déterminer la couleur selon l'utilisation
  let progressColor = 'bg-green-500'; // Vert par défaut (< 50%)
  let textColor = 'text-green-400';
  let warningMessage = null;

  if (usagePercentage >= 80) {
    progressColor = 'bg-red-500'; // Rouge (> 80%)
    textColor = 'text-red-400';
    warningMessage = 'Quota presque atteint !';
  } else if (usagePercentage >= 50) {
    progressColor = 'bg-orange-500'; // Orange (50-80%)
    textColor = 'text-orange-400';
    if (usagePercentage >= 70) {
      warningMessage = 'Attention : quota bientôt atteint';
    }
  }

  // Formater la date de réinitialisation
  const formatResetTime = (resetAtISO) => {
    if (!resetAtISO) return '';
    try {
      const resetDate = new Date(resetAtISO);
      const now = new Date();
      const hoursUntilReset = Math.ceil((resetDate - now) / (1000 * 60 * 60));
      
      if (hoursUntilReset <= 1) {
        return 'dans moins d\'une heure';
      } else if (hoursUntilReset < 24) {
        return `dans ${hoursUntilReset}h`;
      } else {
        return resetDate.toLocaleDateString('fr-FR', { 
          day: 'numeric', 
          month: 'short',
          hour: '2-digit',
          minute: '2-digit'
        });
      }
    } catch (e) {
      return '';
    }
  };

  if (isCollapsed) {
    // Version compacte pour la sidebar repliée
    return (
      <div className="px-2 py-3 border-t border-global-stroke-box">
        <div className="flex flex-col items-center gap-2">
          <div className={`text-xs font-medium ${textColor}`}>
            {callsToday}/{maxCalls}
          </div>
          <div className="w-full h-1.5 bg-global-stroke-box rounded-full overflow-hidden">
            <div
              className={`h-full ${progressColor} transition-all duration-300`}
              style={{ width: `${Math.min(usagePercentage, 100)}%` }}
            />
          </div>
        </div>
      </div>
    );
  }

  // Version complète pour la sidebar dépliée
  return (
    <div className="px-4 py-3 border-t border-global-stroke-box bg-global-bg-box">
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-global-inactive">
            Quota IA
          </span>
          <span className={`text-xs font-semibold ${textColor}`}>
            {callsToday}/{maxCalls}
          </span>
        </div>
        
        {/* Barre de progression */}
        <div className="w-full h-2 bg-global-stroke-box rounded-full overflow-hidden">
          <div
            className={`h-full ${progressColor} transition-all duration-300`}
            style={{ width: `${Math.min(usagePercentage, 100)}%` }}
          />
        </div>

        {/* Message d'avertissement */}
        {warningMessage && (
          <div className={`text-xs ${textColor} font-medium animate-pulse`}>
            {warningMessage}
          </div>
        )}

        {/* Informations supplémentaires */}
        <div className="flex items-center justify-between text-xs text-global-inactive">
          <span>{remaining} restants</span>
          {resetAt && (
            <span className="text-[10px]">
              Reset {formatResetTime(resetAt)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
};

export default AIQuotaIndicator;

