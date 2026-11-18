import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { translate, coverageOf, tableFor, allKeys } from '../shared/i18n';
import { languageByKey, type LanguageDef } from '../shared/languages';

/**
 * The translation layer the pages use.
 *
 * ``t(`profiles.new`)`` returns the string in the chosen language, or the English string when
 * that language does not have that key yet - never the key itself, and never an empty string.
 * A partially translated interface is a normal state for a project this size; showing the user
 * `profiles.new` because a table is 60% done is not.
 *
 * The chosen language is a property of the settings, so it survives a restart and a second
 * window reads the same value.
 */

interface I18nApi {
  t(key: string, fallback?: string): string;
  /** ``t(`a.b`)`` with `{name}` placeholders filled from `values`. */
  f(key: string, values: Record<string, string | number>, fallback?: string): string;
  language: string;
  def: LanguageDef;
  setLanguage(key: string): void;
  rtl: boolean;
  /** Share of the English table this language covers, 0-100. */
  coverage: number;
  keys: string[];
}

const I18nContext = createContext<I18nApi | null>(null);

export function I18nProvider({
  language,
  onChange,
  children,
}: {
  language: string;
  onChange?: (key: string) => void;
  children: ReactNode;
}): ReactNode {
  const [current, setCurrent] = useState(language || 'en');

  useEffect(() => {
    setCurrent(language || 'en');
  }, [language]);

  const setLanguage = useCallback(
    (key: string) => {
      setCurrent(key);
      onChange?.(key);
    },
    [onChange],
  );

  const api = useMemo<I18nApi>(() => {
    const def = languageByKey(current) ?? languageByKey('en')!;
    const table = tableFor(def.key);

    return {
      t: (key, fallback) => {
        // A blank cell in a translation table means "not translated yet", not "show nothing".
        // `??` would treat '' as a real value and print the dotted key, so the English table is
        // consulted before the key is ever shown.
        const value = table[key] || translate(key, def.key);
        return value || fallback || key;
      },
      f: (key, values, fallback) => {
        const template = table[key] || translate(key, def.key) || fallback || key;
        return template.replace(/\{(\w+)\}/g, (_match, name: string) =>
          String(values[name] ?? `{${name}}`),
        );
      },
      language: def.key,
      def,
      setLanguage,
      rtl: def.direction === 'rtl',
      coverage: coverageOf(def.key),
      keys: allKeys(),
    };
  }, [current, setLanguage]);

  useEffect(() => {
    document.documentElement.lang = api.language;
    document.documentElement.dir = api.rtl ? 'rtl' : 'ltr';
  }, [api.language, api.rtl]);

  return <I18nContext.Provider value={api}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nApi {
  const api = useContext(I18nContext);
  if (!api) throw new Error('useI18n must be used inside <I18nProvider>');
  return api;
}

/** Shorthand for the common case. */
export function useT(): (key: string, fallback?: string) => string {
  return useI18n().t;
}
