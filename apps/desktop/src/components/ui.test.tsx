import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import '../i18n';
import { Modal } from './ui';

describe('Modal', () => {
  it('keeps focus in the field being typed in when the parent re-renders', () => {
    const view = (n: number) => (
      <Modal title="x" onClose={() => n}>
        <input aria-label="written" />
        <input aria-label="say as" />
      </Modal>
    );
    const { rerender, getByLabelText } = render(view(1));
    expect(document.activeElement).toBe(getByLabelText('written')); // focus ô đầu khi mở
    getByLabelText('say as').focus();
    rerender(view(2)); // trang cha vẽ lại → onClose là hàm mới
    rerender(view(3));
    expect(document.activeElement).toBe(getByLabelText('say as'));
  });
});
