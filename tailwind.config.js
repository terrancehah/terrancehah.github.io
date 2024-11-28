/** @type {import('tailwindcss').Config} */

module.exports = {
  content: [
    "./*.{html,js}",
    "./src/**/*.{html,js}",
    "./resources/**/*.{html,js}"
  ],
  presets: [],
  darkMode: 'media',
  theme: {
    // ... rest of your existing theme configuration
    extend: {
      fontFamily: {
        raleway: ['Raleway', 'sans-serif'],
        lato: ['Lato', 'sans-serif'],
        caveat: ['Caveat', 'cursive'],
        merriweather: ['Merriweather', 'serif']
      },
      colors: {
        'primary': '#123456',
        'secondary': '#456789',
        'sky-blue': '#4a88c6',
        'light-blue': '#e3f0f7',
      }
    }
  },
  plugins: [],
}