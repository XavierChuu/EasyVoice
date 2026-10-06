import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '../../i18n';
import i18n from '../../i18n';
import type { RuntimeProgress } from '../../lib/platform';
import { RuntimeSetupModal } from './RuntimeSetupModal';

afterEach(() => {
  delete (window as { easyvoice?: unknown }).easyvoice;
});

describe('RuntimeSetupModal', () => {
  it('installs, shows step progress, and surfaces errors for retry', async () => {
    void i18n.changeLanguage('en');
    let push: (p: RuntimeProgress) => void = () => {};
    let fail: (e: Error) => void = () => {};
    const installRuntime = vi.fn(() => new Promise<void>((_, rej) => { fail = rej; }));
    (window as { easyvoice?: unknown }).easyvoice = {
      platform: 'win32',
      runtimeInfo: async () => ({ torch: 'cuda', sizeGb: 4.5, dir: 'C:\\EV\\runtime', installing: false }),
      installRuntime,
      onRuntimeProgress: (cb: (p: RuntimeProgress) => void) => { push = cb; return () => {}; },
    };
    const v = render(<RuntimeSetupModal />);
    const btn = await v.findByText(/Install \(~4\.5 GB\)/);
    expect(v.getByText('CUDA (NVIDIA GPU)')).toBeTruthy();
    fireEvent.click(btn);
    expect(installRuntime).toHaveBeenCalledOnce();
    act(() => push({ step: 'torch', index: 4, total: 5, fraction: null, line: 'Downloading torch' }));
    expect(v.getByText('4/5 · Installing PyTorch')).toBeTruthy();
    expect(v.getByText('70%')).toBeTruthy();
    await act(async () => fail(new Error("Error invoking remote method 'runtime:install': Error: uv pip lỗi (mã 2)")));
    expect(v.getByText("Setup didn't finish")).toBeTruthy();
    expect(v.getByText('uv pip lỗi (mã 2)')).toBeTruthy();
    expect(v.getByRole('button', { name: /↻/ }).hasAttribute('disabled')).toBe(false);
  });
});
