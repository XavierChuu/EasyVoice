import { useEffect } from 'react';

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

export function App() {
  const tab = useUi((s) => s.tab);
  const ready = useEngine((s) => s.ready);
  const firstRunDone = useSettings((s) => s.firstRunDone);

  useEffect(() => {
    void useEngine.getState().init();
  }, []);

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
