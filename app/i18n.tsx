import { createContext, useContext, useMemo, type ReactNode } from "react";
import { createTranslator, DEFAULT_LOCALE, type Locale, type MessageValues } from "./lib/i18n";

const I18nContext = createContext({ locale: DEFAULT_LOCALE, t: createTranslator(DEFAULT_LOCALE) });

export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  const value = useMemo(() => ({ locale, t: createTranslator(locale) }), [locale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export const useI18n = () => useContext(I18nContext);

// Preserve the descriptor API used by components ported from the desktop app.
export type MessageDescriptor = { id: string; defaultMessage: string };
export function defineMessages<T extends Record<string, MessageDescriptor>>(messages: T): T {
  return messages;
}

export function useIntl() {
  const { locale, t } = useI18n();
  return {
    locale,
    formatMessage: (descriptor: MessageDescriptor, values?: MessageValues) =>
      t(descriptor.id, values, descriptor.defaultMessage),
  };
}

export function FormattedMessage({ values, ...descriptor }: MessageDescriptor & { values?: MessageValues }) {
  return <>{useIntl().formatMessage(descriptor, values)}</>;
}
