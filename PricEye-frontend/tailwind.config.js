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
      }
    },
  },
  plugins: [
    require('@tailwindcss/forms'),
    require('@tailwindcss/typography'),
  ],
}

