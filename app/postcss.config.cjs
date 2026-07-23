// Tailwind v4 runs via @tailwindcss/vite (see vite.config.ts), not here.
// Autoprefixer stays so hand-written CSS keeps the same vendor prefixing.
module.exports = {
	plugins: [require("autoprefixer")],
};
