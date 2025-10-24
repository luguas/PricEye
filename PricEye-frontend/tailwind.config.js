/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {},
  },
  plugins: [
    require('@tailwindcss/forms'), // Plugin pour les formulaires
    require('@tailwindcss/typography'), // AJOUTÉ : Plugin pour les classes 'prose'
  ],
}

