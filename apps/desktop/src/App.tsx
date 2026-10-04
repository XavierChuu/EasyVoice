import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { EngineError } from './api/types';

import { EngineBanner, Footer, Header, NoticeBar, Sidebar, Toasts } from './components/Shell';
import { FirstRunModal } from './features/settings/FirstRunModal';
import { LicensesPage } from './features/settings/LicensesPage';
import { SettingsPage } from './features/settings/SettingsPage';
import { StsPage } from './features/sts/StsPage';
import { TtsPage } from './features/tts/TtsPage';
import { VoicesPage } from './features/voices/VoicesPage';
import { useEngine } from './stores/engine';
import { useSettings } from './stores/settings';
import { useUi } from './stores/ui';
import { errorText } from './lib/errors';

export function App() {
  const tab = useUi((s) => s.tab);
  const ready = useEngine((s) => s.ready);
  const firstRunDone = useSettings((s) => s.firstRunDone);

  const { t } = useTranslation();
  useEffect(() => {
    void useEngine.getState().init();
  }, []);
  // Lưới an toàn: lỗi engine chưa được màn hình nào bắt vẫn hiện ra cho người dùng (mã lỗi + thông điệp dễ hiểu).
  useEffect(() => {
    const onReject = (e: PromiseRejectionEvent) => {
      if (e.reason instanceof EngineError) {
        e.preventDefault();
        useUi.getState().setNotice(errorText(t, e.reason));
      }
    };
    window.addEventListener('unhandledrejection', onReject);
    return () => window.removeEventListener('unhandledrejection', onReject);
  }, [t]);

  return (
    <div className="min-h-full flex flex-col bg-bg text-fg">
      <Header />
      <div className="flex-grow flex flex-wrap">
        <Sidebar />
        <main className="flex-[999_1_560px] min-w-0 px-10 py-8 flex flex-col gap-7 max-[720px]:px-4">
          <EngineBanner />
          <NoticeBar />
          {tab === 'voices' && <VoicesPage />}
          {tab === 'tts' && <TtsPage />}
          {tab === 'sts' && <StsPage />}
          {tab === 'settings' && <SettingsPage />}
          {tab === 'licenses' && <LicensesPage />}
        </main>
      </div>
      <Footer />
      <Toasts />
      {ready && !firstRunDone && <FirstRunModal />}
    </div>
  );
}
