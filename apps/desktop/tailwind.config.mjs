/** Token màu/typography lấy từ docs/EasyVoice UI mẫu.html (thiết kế đã chốt). */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0A0A0A',
        stripe: '#0E0E0E',
        grid: '#161616',
        line: '#2B2B2B',
        line2: '#1C1C1C',
        line3: '#3D3D3D',
        fg: '#F2F2F2',
        soft: '#C8C8C8',
        mute: '#8F8F8F',
        dim: '#6A6A6A',
        acc: '#FF5B14',
        acc2: '#FF8A57',
      },
      fontFamily: {
        sans: ['"Chakra Petch"', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'monospace'],
      },
      letterSpacing: { label: '.1em', wide2: '.12em', brand: '.16em' },
    },
  },
  plugins: [],
};
