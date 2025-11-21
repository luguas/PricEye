/** @type {import('tailwindcss').Config} */
export default {
  // Activer le dark mode en utilisant une classe sur l'élément <html>
  darkMode: 'class', 
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      // Définir les couleurs sémantiques
      colors: {
        'bg-primary': 'var(--color-bg-primary)',
        'bg-secondary': 'var(--color-bg-secondary)',
        'bg-sidebar': 'var(--color-bg-sidebar)',
        'bg-muted': 'var(--color-bg-muted)',
        
        'text-primary': 'var(--color-text-primary)',
        'text-secondary': 'var(--color-text-secondary)',
        'text-muted': 'var(--color-text-muted)',
        'text-sidebar': 'var(--color-text-sidebar)',
        'text-sidebar-active': 'var(--color-text-sidebar-active)',
        
        'border-primary': 'var(--color-border-primary)',
        'border-secondary': 'var(--color-border-secondary)',
        'global-stroke-box': 'rgba(49, 65, 88, 0.50)',
        'global-bg-box': 'rgba(15, 23, 43, 0.40)',
        'global-blanc': '#ffffff',
        'global-stroke-highlight-2nd': 'rgba(0, 184, 219, 0.30)',
        'global-content-highlight-2nd': '#00d3f2',
        'global-inactive': '#90a1b9',
        'global-positive-impact': '#00d492',
        'global-bg-small-box': 'rgba(29, 41, 61, 0.50)',
        'global-negative-impact': '#dd3e3e',
        'global-mid-impact': '#fef137',
        'global-content-highlight-3rd': '#00d492',
        'global-bg': '#0f172b',
        // Couleurs calendrier
        'calendrierbg-bleu': 'rgba(0, 140, 255, 0.1)',
        'calendrierbg-orange': 'rgba(255, 144, 0, 0.1)',
        'calendrierbg-vert': 'rgba(0, 219, 110, 0.1)',
        'calendrierstroke-bleu': 'rgba(0, 157, 255, 0.3)',
        'calendrierstroke-orange': 'rgba(255, 183, 0, 0.3)',
        'calendrierstroke-vert': 'rgba(0, 255, 128, 0.3)',
      },
      fontFamily: {
        'h2-font-family': ['Avenir', 'Avenir-Heavy', 'Montserrat', 'sans-serif'],
        'h3-font-family': ['Avenir', 'Avenir-Medium', 'Montserrat', 'sans-serif'],
        'h4-font-family': ['Arial', 'sans-serif'],
        'p1-font-family': ['Average Sans', 'AverageSans-Regular', 'Roboto', 'sans-serif'],
        'p2-font-family': ['Average Sans', 'AverageSans-Regular', 'Roboto', 'sans-serif'],
        'h1-font-family': ['Avenir', 'Avenir-Heavy', 'Montserrat', 'sans-serif'],
        // Fonts génériques pour utilisation directe avec fallbacks
        // Avenir : utilise Montserrat (gratuit, similaire) ou Avenir si disponible sur le système
        'Avenir': [
          'Avenir',
          'Avenir Next',
          'Avenir-Heavy',
          'Avenir-Medium',
          'Montserrat', // Alternative gratuite depuis Google Fonts
          '-apple-system', // Avenir est préinstallée sur macOS
          'BlinkMacSystemFont',
          'Segoe UI',
          'Helvetica Neue',
          'Helvetica',
          'Arial',
          'sans-serif'
        ],
        // Average Sans : utilise Roboto (gratuit, similaire) ou Average Sans si disponible
        'Average_Sans': [
          'Average Sans',
          'AverageSans-Regular',
          'AverageSans',
          'Roboto', // Alternative gratuite depuis Google Fonts
          'Helvetica Neue',
          'Helvetica',
          'Arial',
          'sans-serif'
        ],
      },
      fontSize: {
        'h2-font-size': '20px',
        'h3-font-size': '16px',
        'h4-font-size': '14px',
        'p1-font-size': '12px',
        'p2-font-size': '11px',
        'h1-font-size': '30px',
      },
      fontWeight: {
        'h2-font-weight': '400',
        'h3-font-weight': '500',
        'h4-font-weight': '400',
        'p1-font-weight': '400',
        'p2-font-weight': '400',
        'h1-font-weight': '400',
      },
      lineHeight: {
        'h2-line-height': 'normal',
        'h3-line-height': 'normal',
        'h4-line-height': '20px',
        'p1-line-height': 'normal',
        'p2-line-height': 'normal',
        'h1-line-height': 'normal',
      },
    },
  },
  plugins: [
    require('@tailwindcss/forms'),
    require('@tailwindcss/typography'),
  ],
}

