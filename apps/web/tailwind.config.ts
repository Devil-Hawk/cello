import type { Config } from 'tailwindcss'

const config: Config = {
  darkMode: ['class'],
  content: [
    './pages/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './app/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
  ],
  theme: {
    container: {
      center: true,
      padding: '2rem',
      screens: {
        '2xl': '1400px',
      },
    },
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        sunken: 'hsl(var(--sunken))',
        raised: {
          DEFAULT: 'hsl(var(--raised))',
          foreground: 'hsl(var(--raised-foreground))',
        },
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        // The accent ramp — one hue, four deliberate steps. `DEFAULT` is the
        // live signal; `hover`/`active` give filled accent surfaces real
        // press feedback instead of a flat opacity dim; `soft`/`tint` are
        // backgrounds (badges, highlighted rows) derived from the same
        // hue so they stay in register with `DEFAULT` in both themes;
        // `deep` is the only step contrast-checked for text-on-card.
        brand: 'hsl(var(--brand))',
        accent: {
          DEFAULT: 'hsl(var(--accent))', // #EA580C — live signal, fills + rings
          foreground: 'hsl(var(--accent-foreground))',
          hover: 'hsl(var(--accent-hover))', // filled-surface hover
          active: 'hsl(var(--accent-active))', // filled-surface press
          deep: 'hsl(var(--accent-deep))', // #C2410C as text on light
          soft: 'hsl(var(--accent) / 0.12)', // badge / highlight fill
          tint: 'hsl(var(--accent) / 0.06)', // barest wash — hover backgrounds
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        // Legacy brand ramp kept for transitional pages; new code uses `accent`.
        cello: {
          50: '#FFF7ED',
          100: '#FFEDD5',
          200: '#FED7AA',
          300: '#FDBA74',
          400: '#FB923C',
          500: '#F97316',
          600: '#EA580C',
          700: '#C2410C',
          800: '#9A3412',
          900: '#7C2D12',
          950: '#431407',
        },
        // Pipeline stage palette — desaturated to instrument tones so the
        // board reads as calibrated gauges, never candy. Fixed across themes.
        pipeline: {
          discovered: '#5B7C9E', // slate blue
          applied: '#8578B0', // muted violet
          screen: '#BE9A46', // ochre
          interview: '#4B9285', // pine teal
          offer: '#4E9A6B', // pine green
          ghosted: '#7C838F', // graphite
          rejected: '#C05F5A', // clay red
        },
      },
      borderRadius: {
        control: '8px',
        card: '12px',
        modal: '16px',
        lg: '12px',
        md: '8px',
        sm: '6px',
      },
      boxShadow: {
        card: '0 1px 2px 0 rgb(16 18 23 / 0.04), 0 2px 6px -1px rgb(16 18 23 / 0.05)',
        pop: '0 2px 8px -2px rgb(16 18 23 / 0.08), 0 8px 24px -4px rgb(16 18 23 / 0.16)',
        // Raised readout housings sit proud of the panel.
        raised:
          '0 1px 0 0 rgb(255 255 255 / 0.6) inset, 0 1px 2px 0 rgb(16 18 23 / 0.05), 0 6px 16px -6px rgb(16 18 23 / 0.14)',
        // Recessed wells (kanban tracks, input grooves).
        well: 'inset 0 1px 2px 0 rgb(16 18 23 / 0.06)',
      },
      fontSize: {
        display: ['2.125rem', { lineHeight: '1.15', letterSpacing: '-0.025em', fontWeight: '600' }],
        title: ['1.5rem', { lineHeight: '1.25', letterSpacing: '-0.02em', fontWeight: '600' }],
        section: ['1.125rem', { lineHeight: '1.35', letterSpacing: '-0.01em', fontWeight: '600' }],
        body: ['0.875rem', { lineHeight: '1.55' }],
        caption: ['0.8125rem', { lineHeight: '1.45' }],
        label: ['0.6875rem', { lineHeight: '1.2', letterSpacing: '0.08em', fontWeight: '500' }],
        stat: ['1.75rem', { lineHeight: '1.1', letterSpacing: '-0.02em', fontWeight: '600' }],
        // Monospace instrument readout — vitals + gauges. Pair with font-readout.
        readout: ['1.5rem', { lineHeight: '1.05', letterSpacing: '-0.01em', fontWeight: '700' }],
        'readout-lg': ['2.375rem', { lineHeight: '1', letterSpacing: '-0.02em', fontWeight: '700' }],
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'system-ui', 'sans-serif'],
        display: ['var(--font-display)', 'system-ui', 'sans-serif'],
        readout: ['var(--font-readout)', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
        'slide-in-from-right': {
          from: { transform: 'translateX(100%)' },
          to: { transform: 'translateX(0)' },
        },
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
        'slide-in': 'slide-in-from-right 0.3s ease-out',
        'fade-in': 'fade-in 0.2s ease-out',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
}

export default config
