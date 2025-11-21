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
      },
      fontFamily: {
        'h2-font-family': ['"Avenir-Heavy"', 'sans-serif'],
      },
      fontSize: {
        'h2-font-size': '20px',
      },
      fontWeight: {
        'h2-font-weight': '400',
      },
      lineHeight: {
        'h2-line-height': 'normal',
      },
    },
  },
  plugins: [
    require('@tailwindcss/forms'),
    require('@tailwindcss/typography'),
  ],
}

