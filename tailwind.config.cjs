/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/renderer/index.html",
    "./src/renderer/src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Surge-like 配色（统一引用 CSS 变量，跟随浅色/暗色主题）
        sidebar: {
          bg: 'var(--color-surface)',
          hover: 'var(--color-surface-hover)',
          active: 'var(--color-surface-active)',
          text: 'var(--color-text)',
          muted: 'var(--color-muted2)',
          border: 'var(--color-border)',
        },
        content: {
          bg: 'var(--color-bg)',
          card: 'var(--color-surface)',
          border: 'var(--color-border)',
        },
        // 主色调（锚定到全站实际使用的 Apple 系统蓝 #0a84ff）
        primary: {
          50: '#e8f1ff',
          100: '#cfe3ff',
          200: '#9cc6ff',
          300: '#66a9ff',
          400: '#3a96ff',
          500: '#0a84ff',
          600: '#0a6fd6',
          700: '#095bb0',
          800: '#08478a',
          900: '#063365',
        },
        // 语义别名（统一引用 CSS 变量）
        accent: 'var(--color-accent)',
        muted: 'var(--color-muted)',
        muted2: 'var(--color-muted2)',
        link: 'var(--color-info)',
        // 状态色（统一，消除 #30d158 / #ff453a 等离群值）
        success: '#34c759',
        warning: '#ff9f0a',
        danger: '#ff3b30',
        info: '#0a84ff',
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'SF Pro Text', 'Helvetica Neue', 'sans-serif'],
        mono: ['SF Mono', 'Menlo', 'Monaco', 'monospace'],
      },
      fontSize: {
        '2xs': '0.75rem',
      },
      animation: {
        'fade-in': 'fadeIn 0.2s ease-out',
        'slide-up': 'slideUp 0.3s ease-out',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
    },
  },
  plugins: [],
};
