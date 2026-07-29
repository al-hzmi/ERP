'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { CalendarPreference, Locale, NumeralSystem } from '@/lib/utils/format';

/**
 * Client-side UI preferences.
 *
 * Persisted to localStorage so a user's choice of calendar and numeral system
 * survives a reload. Server state lives in React Query, not here — mixing the
 * two is how a store ends up holding a stale copy of the invoice list.
 */

interface UiState {
  locale: Locale;
  numerals: NumeralSystem;
  calendar: CalendarPreference;
  theme: 'light' | 'dark';
  sidebarCollapsed: boolean;
  activeBranchId: string | null;

  setLocale: (locale: Locale) => void;
  setNumerals: (numerals: NumeralSystem) => void;
  setCalendar: (calendar: CalendarPreference) => void;
  toggleTheme: () => void;
  toggleSidebar: () => void;
  setActiveBranch: (branchId: string | null) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set, get) => ({
      locale: 'ar',
      numerals: 'western',
      calendar: 'both',
      theme: 'light',
      sidebarCollapsed: false,
      activeBranchId: null,

      setLocale: (locale) => {
        set({ locale });
        if (typeof document !== 'undefined') {
          document.documentElement.lang = locale;
          document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr';
        }
      },
      setNumerals: (numerals) => set({ numerals }),
      setCalendar: (calendar) => set({ calendar }),
      toggleTheme: () => {
        const theme = get().theme === 'dark' ? 'light' : 'dark';
        set({ theme });
        if (typeof document !== 'undefined') {
          document.documentElement.setAttribute('data-theme', theme);
          try {
            localStorage.setItem('erp-theme', theme);
          } catch {
            // A browser with storage disabled still gets the theme for this
            // session; it simply will not remember it.
          }
        }
      },
      toggleSidebar: () => set({ sidebarCollapsed: !get().sidebarCollapsed }),
      setActiveBranch: (activeBranchId) => set({ activeBranchId }),
    }),
    {
      name: 'erp-ui-preferences',
      partialize: (state) => ({
        locale: state.locale,
        numerals: state.numerals,
        calendar: state.calendar,
        theme: state.theme,
        sidebarCollapsed: state.sidebarCollapsed,
        activeBranchId: state.activeBranchId,
      }),
    },
  ),
);
