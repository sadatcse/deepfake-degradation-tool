'use client';

import { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function ThemeToggle() {
  const [dark, setDark] = useState(true);

  useEffect(() => {
    setDark(document.documentElement.classList.contains('dark'));
  }, []);

  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle('dark', next);
    try {
      localStorage.setItem('ddt-theme', next ? 'dark' : 'light');
    } catch {
      // Private browsing or blocked storage - the toggle still works for this session.
    }
  };

  return (
    <Button variant="ghost" size="icon" onClick={toggle} aria-label="Toggle colour theme">
      {dark ? <Moon /> : <Sun />}
    </Button>
  );
}
