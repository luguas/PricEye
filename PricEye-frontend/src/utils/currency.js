/**
 * Taux de change depuis l'euro (1 EUR = X devise).
 * À mettre à jour périodiquement ou via une API si besoin.
 */
const RATES_FROM_EUR = {
  EUR: 1,
  USD: 1.09,
  GBP: 0.86,
  CHF: 0.95,
};

/**
 * Convertit un montant en euros vers la devise cible.
 * @param {number} amountEur - Montant en euros
 * @param {string} targetCurrency - Code devise (EUR, USD, etc.)
 * @returns {number} Montant converti (arrondi à 2 décimales)
 */
export function convertFromEur(amountEur, targetCurrency = 'EUR') {
  if (amountEur == null || isNaN(Number(amountEur))) return 0;
  const code = (targetCurrency || 'EUR').toUpperCase();
  const rate = RATES_FROM_EUR[code] ?? 1;
  return Math.round(Number(amountEur) * rate * 100) / 100;
}
