import React from 'react';
import { fireEvent } from '@testing-library/react';
import { newPaykitId, PaykitReceiverWorkspace, PaykitState } from 'shared/paykitApi';
import { renderWithProviders } from 'utils/tests';
import PaykitLinks from './PaykitLinks';

const receiverId = newPaykitId();
const workspace: PaykitReceiverWorkspace = {
  receiverId,
  deliveryPaused: true,
  links: [],
  profiles: [],
  contacts: [],
  discoveries: [],
};
const state: PaykitState = {
  apiVersion: 1,
  environmentId: newPaykitId(),
  ready: true,
  lastEventSequence: 0,
  participants: [],
  receivers: [],
  operations: [],
};
describe('Editable encrypted links', () => {
  it('uses the selected receiver and explicit peer path, with separate pause and queue actions', () => {
    const command = jest.fn().mockResolvedValue(undefined);
    const view = renderWithProviders(
      <PaykitLinks
        receiverId={receiverId}
        workspace={workspace}
        state={state}
        disabled={false}
        command={command}
      />,
    );
    expect(view.getByText('Sync private delivery').closest('button')).toBeDisabled();
    fireEvent.click(view.getByText('Resume private delivery'));
    expect(command).toHaveBeenCalledWith('delivery.resume', { receiverId });
    fireEvent.change(view.getByLabelText('Link peer public key'), {
      target: { value: 'y'.repeat(52) },
    });
    fireEvent.change(view.getByLabelText('Link peer receiver path'), {
      target: { value: 'bob/server' },
    });
    fireEvent.click(view.getByText('Queue empty encrypted list'));
    expect(command).toHaveBeenCalledWith('link.sendEmptyList', {
      receiverId,
      peerPublicKey: 'y'.repeat(52),
      peerReceiverPath: 'bob/server',
    });
  });
  it('shows unknown states, recovery and queued/published/received evidence independently', () => {
    const link = {
      peerPublicKey: 'peer',
      peerReceiverPath: 'bob/server',
      state: 'future-state',
      generation: 1,
      failureCount: 2,
      pendingMessages: 3,
      latestReceivedListId: '18446744073709551615',
      lastSentMessageId: '123',
      lastError: 'Peer offline',
    };
    const view = renderWithProviders(
      <PaykitLinks
        receiverId={receiverId}
        workspace={{
          ...workspace,
          links: [
            link,
            { ...link, peerReceiverPath: 'bob/wallet', state: 'recoveryRequired' },
          ],
        }}
        state={state}
        disabled
        command={jest.fn()}
      />,
    );
    expect(view.getByText(/Unsupported link state/)).toBeInTheDocument();
    expect(view.getByText(/This link requires explicit relinking/)).toBeInTheDocument();
    expect(view.getAllByText('18446744073709551615')).toHaveLength(2);
    expect(view.getAllByText('123')).toHaveLength(2);
    expect(view.getByText('Initiate link').closest('button')).toBeDisabled();
  });
});
