/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: { 500: "#f59e0b", 600: "#d97706" },
      },
    },
  },
  plugins: [],
};
