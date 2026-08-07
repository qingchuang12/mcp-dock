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
        // Surge-like 配色
        sidebar: {
          bg: '#2c2c2e',
          hover: '#3a3a3c',
          active: '#48484a',
          text: '#ffffff',
          muted: '#98989d',
          border: '#3a3a3c',
        },
        content: {
          bg: '#1c1c1e',
          card: '#2c2c2e',
          border: '#3a3a3c',
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
        // 语义别名
        accent: '#0a84ff',
        muted: '#636366',
        muted2: '#98989d',
        link: '#5ac8fa',
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
        '2xs': '0.625rem',
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
