import { Monitor, Moon, Sun } from 'lucide-react';
import * as React from 'react';
import { Button } from '@/components/ui/button';

export type Theme = 'dark' | 'light' | 'system';
const STORAGE_KEY = 'subscriberr-theme';

function readStored(): Theme {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'light' || v === 'system' || v === 'dark' ? v : 'dark'; // dark by default (Spec §13)
  } catch {
    return 'dark';
  }
}

function apply(theme: Theme): void {
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
}

/** Called once before the first render so the stored choice applies without a flash. */
export function initTheme(): void {
  apply(readStored());
}

const ThemeContext = React.createContext<{ theme: Theme; setTheme: (t: Theme) => void }>({ theme: 'dark', setTheme: () => {} });

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = React.useState<Theme>(readStored);

  React.useEffect(() => {
    apply(theme);
    if (theme !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => apply('system');
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [theme]);

  const setTheme = React.useCallback((t: Theme) => {
    try {
      localStorage.setItem(STORAGE_KEY, t);
    } catch {
      /* private mode: the choice just will not persist */
    }
    setThemeState(t);
  }, []);

  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>;
}

const ORDER: Theme[] = ['dark', 'light', 'system'];
const ICON = { dark: Moon, light: Sun, system: Monitor } as const;

/** Cycles dark → light → system. */
export function ThemeToggle() {
  const { theme, setTheme } = React.useContext(ThemeContext);
  const Icon = ICON[theme];
  const next = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length] ?? 'dark';
  return (
    <Button variant="ghost" size="icon" onClick={() => setTheme(next)} aria-label={`Theme: ${theme}. Switch to ${next}.`} title={`Theme: ${theme}`}>
      <Icon />
    </Button>
  );
}
