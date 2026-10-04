import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import { useSettings } from '../stores/settings';
import en from './en.json';
import vi from './vi.json';

void i18n.use(initReactI18next).init({
  resources: { vi: { translation: vi }, en: { translation: en } },
  lng: useSettings.getState().lang,
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});

useSettings.subscribe((s) => {
  if (i18n.language !== s.lang) void i18n.changeLanguage(s.lang);
  document.documentElement.lang = s.lang;
});

export default i18n;
